# PostgreSQL AI preparation stage

Default-campaign runtime assignment and stopped-worker catch-up are documented in [DEFAULT_CAMPAIGN_RUNTIME.md](./DEFAULT_CAMPAIGN_RUNTIME.md). Workspace settings and source automation remain authoritative; only Default campaign drafts/jobs execute in this stage.

AI settings are at `/workspace/ai-settings`; PostgreSQL review is at `/workspace/ai-drafts`. Both require verified, approved workspace access and automation permission. The navigation calls the review page **AI Drafts**. The owner-only SQLite/n8n workflow remains at `/review`, including its independent publishing and auto-publish controls.

AI preparation never calls Telegram. Approve and Reject change only the review status (and concurrency revision/timestamps). Save changes final text and returns it to pending review. Save edits before approving or rejecting. Manual direct publishing is a separate Publish action; see [DIRECT_PUBLISHING.md](./DIRECT_PUBLISHING.md). Sources now also require the default-off Telegram automation toggle for AI preparation; monitoring and RSS remain independent. Publication locks prevent editing or review changes while a post is queued, sending, uncertain, or published.

## Setup and commands

Run commands from `web`. Keep the existing dependency versions.

```powershell
npx.cmd prisma migrate deploy --config ./prisma7.config.ts
npx.cmd prisma generate --config ./prisma7.config.ts
npm.cmd run dev
npm.cmd run worker:telegram
# Check/process at most one eligible Telegram preparation job:
npm.cmd run worker:telegram:once
# Run independently, as before:
npm.cmd run worker:rss
```

The additive migration is `prisma/migrations/20261005120000_workspace_ai_drafts/migration.sql`. It creates settings, drafts and the review enum, and adds a nullable job outcome. It was applied to the configured PostgreSQL database during implementation; no reset or changes to existing post text were performed. Prisma Client was regenerated at `src/generated/prisma` (already ignored by Git).

Use the existing `DATABASE_URL` and `INGEST_WORKSPACE_ID` configuration. Only that ingestion workspace can activate AI in this stage. Other workspaces can save prompts but see a clear connection-unavailable explanation. Configure `OLLAMA_URL` on the server if necessary; its default is `http://127.0.0.1:11434`. There is no user-editable endpoint field. Ollama runs on Windows and must have `gpt-oss:latest` installed. The explicit model allowlist lives in `src/lib/ai-config.ts`; initially it contains only that model.

Settings start disabled with the supplied base prompt and an empty perspective. First activation records PostgreSQL server time once. All eligibility checks use `OriginalPost.receivedAt > activatedAt`, irrespective of publication date. Old pending jobs remain untouched. Prompt changes and pause/resume advance the settings revision and preserve activation time.

## Worker behavior

`scripts/telegram-worker.ts` loads environment configuration and owns a PrismaPg client, without importing server-only code. `scripts/telegram-processing.ts` implements one-job processing. Ingestion already creates independent Telegram/RSS jobs and needed no changes.

Claims use a single PostgreSQL statement with `FOR UPDATE SKIP LOCKED`, a random lock token and a 240-second lease. The Ollama request (including response reading) has a 180-second deadline; database transactions have a 10-second timeout. Expired or missing leases can recover. Every attempted generation is counted before the network call, so crashes count toward the five-attempt limit. Exhausted expired claims become failed. Transient failures back off from 5 seconds to a bounded 300 seconds; permanent HTTP/configuration failures terminate. Existing drafts are preserved, including manually edited final text.

Before generation and committing, the worker checks current approval, verified email, automation permission, enabled AI settings and the settings revision. Access/settings rows are locked only during short database decisions. Network calls run outside transactions. A settings change or access revocation discards the result and refunds that generation attempt; paused work waits without consuming attempts. Completion and retry updates require ownership of the unexpired token. Draft creation and job completion commit together. A unique workspace/original constraint prevents duplicate drafts.

Ollama receives the effective editorial instructions in a system message and the untrusted source in a separate user message, with `POST /api/chat` and `stream: false`. Only the assistant's final `message.content` is used. Thinking is never saved. Empty, malformed, overlong, incomplete and token-limit outputs fail validation. Responses are capped at 2 MiB; news output is capped at 20,000 characters and generation at 8,192 tokens. Exactly `NO_NEWS_CONTENT`, after trimming, completes the job with `outcome = SKIPPED_NO_NEWS_CONTENT`; it creates no draft. Provider bodies, news text, prompts, connection strings and arbitrary database exceptions are not logged. Recent failed preparation jobs are shown on AI Drafts.

API behavior was checked against [Ollama's chat documentation](https://docs.ollama.com/api/chat).

The initial full-prompt live request encountered a CUDA memory error (HTTP 500). The integration now uses a smaller evaluation batch (`num_batch: 64`) and the `gpt-oss` low thinking setting while retaining the 32,768-token context and 8,192-token output bound. The full approved-prompt request then succeeded through the actual worker, creating one PostgreSQL draft from synthetic news. [Ollama's runner options](https://github.com/ollama/ollama/blob/main/api/types.go) define the batch parameter. Runtime resource failures still use bounded retries.

## Changed files

- `prisma/schema.prisma` and the additive migration: workspace-scoped settings/drafts, review enum, job outcome.
- `package.json`: Telegram worker and verification commands; dependencies unchanged.
- `src/lib/ai-config.ts`, `ai-prompt.ts`, `ai-db.ts`, `ollama.ts`: shared configuration, approved prompt, transactional access checks, bounded Ollama integration.
- `scripts/telegram-worker.ts`, `telegram-processing.ts`: standalone worker and claim/commit/retry lifecycle.
- `src/app/actions/ai.ts`: settings and final-text/review actions with revision checks and fresh workspace access.
- `src/app/workspace/ai-settings/page.tsx`, `ai-drafts/page.tsx`: light settings and paginated review pages.
- `src/components/AiSettingsEditor.tsx`, `AiDraftEditor.tsx`, `AppNavigation.tsx`: editors and permission-aware navigation.
- `src/app/actions/users.ts`: invalidate the new pages after service/account access changes.
- `scripts/check-telegram-preparation.ts`, `ai-action-checks.ts`: isolated PostgreSQL verification with synthetic data and clearly separated mocks.
- `AI_PREPARATION.md`, `REDESIGN.md`: delivery and route documentation.

## Verification

```powershell
npx.cmd tsc --noEmit
npm.cmd run lint
npm.cmd run build
npm.cmd run check:telegram
# Include a real local Ollama request with the approved prompt and synthetic news:
npm.cmd run check:telegram -- --ollama
```

The integration check creates a randomly named PostgreSQL schema, applies migrations there, and removes it in `finally`. It requires permission to create schemas. It does not process application jobs or send Telegram messages. It runs the existing RSS worker from a temporary copy with only its database adapter redirected to that schema; that copy is removed afterward.

Passed against real PostgreSQL with mocked generation: older-job exclusion (including a newer publication date), new-post eligibility (including an old publication date), one draft per original, retained manual edits, atomic concurrent claims, expired claim recovery, stale-worker discard, exhausted crash recovery, suspension and automation/settings pauses, changed-settings discard/refund, exact no-news skips, output validation, thinking exclusion, and bounded retries. The real RSS worker created its independent item and preserved subsequent manual edits in the isolated schema.

The actual AI server actions and workspace guard also passed with real PostgreSQL; only the session boundary and Next redirect/revalidation adapters were mocked. Checks covered unverified/suspended access, disabled automation, foreign-workspace draft access, revision conflicts, status-only approval, model allowlist, disconnected activation rejection, first activation and pause/resume preservation. Authenticated browser/OAuth checks remain manual.

`check:telegram -- --ollama` passed with the actual local `gpt-oss:latest` endpoint and actual PostgreSQL: the final worker result was saved as a pending-review draft with the approved effective prompt/revision. Synthetic data and the disposable schema were removed afterward. This verifies live generation/storage; it does not replace authenticated browser/OAuth or a real reader-ingestion end-to-end check. No Telegram publication was performed.

TypeScript and lint passed. Production build passed with the existing external-lockfile warning. The first sandboxed build could not fetch existing Google Fonts; the build passed when network access was allowed. No dependency or font changes were needed.

## Manual test procedure

1. Sign in as a verified, approved account with automation permission in the configured ingestion workspace. Open AI settings; confirm it starts disabled with the supplied prompt. Activate once and note the activation time. An automation-enabled workspace without the connected reader should show the connection explanation and reject activation.
2. Keep an older pending Telegram job. Receive a new post through the existing reader after activation, even if its publication date is older. Run `worker:telegram:once`; only the newly received post should produce a draft. The older job remains pending, and original text is preserved.
3. Open AI Drafts. Compare original/AI text, edit and Save final text, then Approve or Reject. Check `/review` remains separate. Nothing is sent to Telegram. Open the same draft in two tabs; save in one and verify the second tab's stale save fails.
4. Run two Telegram workers against new test posts. Verify one draft per original. Kill a worker during generation, wait beyond its 240-second lease, and restart. Verify recovery or a terminal failure after five attempts.
5. During generation, save a changed prompt, disable AI, suspend the owner, or disable automation. Verify no stale draft is saved. Restore access/resume, wait for backoff, and verify current settings are used while activation time stays unchanged.
6. Ingest a promotional-only test post. Verify a model return of exactly `NO_NEWS_CONTENT` records the skipped outcome without a draft. A truncated/incomplete answer should be retried or fail, never become a successful draft.
7. Run the RSS worker independently and verify its feed/items continue to work. Check real authenticated navigation and Arabic/English editing on desktop/mobile.
