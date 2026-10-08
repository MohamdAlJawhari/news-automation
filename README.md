# News Automation

News Automation collects posts from selected Telegram channels, preserves their original text, and prepares content for RSS feeds and editorial review. The web application manages workspace access, source channels, feed rules, and AI drafts.

The PostgreSQL campaign workflow prepares drafts with local Ollama, then supports separate manual Save, Approve and Publish actions through the connected reader. An older owner-only SQLite/n8n review and publishing workflow remains available separately.

See [CAMPAIGN_UI.md](CAMPAIGN_UI.md) for the current campaign interface, validation and restart handoff. Earlier workspace-only AI UI instructions below are superseded by that document.

## Current features

### Accounts and workspaces

- Google sign-in through Better Auth, backed by PostgreSQL.
- Email verification and approval checks before workspace access.
- Owner administration for pending, approved, rejected, and suspended accounts.
- Separate RSS and automation permissions for each workspace.
- Account-status explanations and server-side checks on pages, actions, and APIs.

### Telegram source ingestion

- Manage and pause workspace source channels from the Channels dashboard.
- Connect a Telegram account using the standalone reader.
- Refresh eligible sources every 15 seconds and resolve their Telegram identities.
- Receive new text posts, preserve their source details and original text in PostgreSQL, and deduplicate repeated ingestion.
- Create separate `RSS_PREPARE` and `TELEGRAM_PREPARE` jobs according to workspace permissions.
- Exclude the configured output channel from sources to prevent feedback loops.

The initial reader connection targets the workspace configured by `INGEST_WORKSPACE_ID`. General connections for multiple workspaces are future work.

### RSS feeds

- Independent RSS worker and a separate feed for each source channel.
- Feed metadata, enable/pause controls, header/footer text, removal rules, and ordered replacement rules.
- Token-based feed links with creation, replacement, and revocation; only token hashes are stored.
- Original and processed post views, final RSS content editing, and hide/restore controls.
- Revision checks to reject stale manual edits and retries that preserve saved content.

RSS processing runs independently of the AI preparation worker.

### Local AI preparation and review

- Campaign settings for an enabled state, editable system prompt, preferred editorial perspective, and an explicit local-model allowlist.
- Initial model: `gpt-oss:latest`; initial state: disabled.
- A one-time server activation timestamp: only originals received afterward are eligible. Publication dates do not control eligibility, and older pending jobs remain untouched.
- Local Ollama rewriting with editorial instructions separate from untrusted source text.
- Final-answer validation, bounded timeouts, retries, atomic claims, expiring leases, and crash recovery.
- Fresh approval, automation, and settings checks before generation and saving; stale results are discarded.
- One PostgreSQL AI draft per original in each campaign, preserving originals and later manual edits.
- A searchable, paginated campaign **Drafts** page with Cards/Compare layouts and expandable original post/AI output, with Save, Approve, Reject, and stale-edit protection.
- Exactly `NO_NEWS_CONTENT` records a terminal skipped outcome without creating a draft.

Manual Approve records a review decision only. Campaign Auto-send is separately confirmed, off by default, and queues only future eligible posts through the existing reader publisher. Existing drafts remain manual. See [AUTO_SEND.md](AUTO_SEND.md) for flow, schema, validation and rollout/rollback. Thinking output is never used as news text.

### Separate legacy review and publishing

Verified, approved owners can still use `/review` for the existing SQLite/n8n workflow: draft editing, approval/rejection, manual publishing, automatic publishing controls, and recovery of uncertain delivery. `/channels` manages its legacy SQLite sources. These records and settings are separate from PostgreSQL sources, RSS items, and AI drafts.

## How the project fits together

```text
Telegram source channels
        |
        v
telegram-reader -> web ingestion API -> PostgreSQL originals and jobs
                                            |
                         +------------------+------------------+
                         |                                     |
                    RSS worker                         Telegram preparation worker
                         |                                     |
                    RSS items                              Local Ollama
                         |                                     |
                    RSS endpoint                       PostgreSQL AI drafts
                                                               |
                                                         Human review

Separate legacy path: n8n -> SQLite drafts -> owner /review -> n8n publishing
```

| Folder | Purpose |
| --- | --- |
| `telegram-reader/` | Telegram account login, source monitoring, and direct ingestion. |
| `web/` | Next.js application, authentication, APIs, Prisma schema/migrations, workers, and checks. |
| `n8n-data/` | Local n8n workflows, database, configuration, storage, and logs for the existing workflow. |

See [project tree.txt](project%20tree.txt) for the annotated folder and file inventory. Dependency, build, cache, and Git internals are collapsed in that inventory.

## Stack

- Next.js **16.3.8**, React **19.2.8**, TypeScript, and Tailwind CSS.
- Prisma **7.10.0**, PostgreSQL, and the Prisma PostgreSQL driver adapter.
- Prisma configuration: `web/prisma7.config.ts`; generated client: `web/src/generated/prisma`.
- Better Auth with Google sign-in.
- Local Ollama running directly on Windows, initially using `gpt-oss:latest`.
- Node.js Telegram reader using `teleproto`.
- SQLite and n8n for the preserved legacy workflow.

## Configuration

Set local values in `web/.env` or `web/.env.local`, and reader values in `telegram-reader/.env`. The names below describe configuration; no credentials are included in this README.

| Component | Variables | Purpose |
| --- | --- | --- |
| Web/database | `DATABASE_URL`, `SHADOW_DATABASE_URL` | PostgreSQL connection and shadow database setting used by the Prisma config. |
| Authentication | `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Application origin, auth secret, and Google OAuth credentials. |
| Web ingestion | `INGEST_WORKSPACE_ID`, `INGEST_READER_SECRET`, `TELEGRAM_OUTPUT_CHAT_ID` | Connected workspace, reader authentication, and output-channel exclusion. |
| AI worker | `OLLAMA_URL` | Server-controlled Ollama URL; defaults to `http://127.0.0.1:11434`. |
| Reader | `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `OUTPUT_CHAT_ID` | Telegram client credentials and output exclusion. |
| Reader/API connection | `CHANNELS_API_URL`, `INGEST_POSTS_URL`, `INGEST_READER_SECRET` | Workspace source-list endpoint, original-post endpoint, and matching reader secret. |
| Reader/legacy exclusion | `INTAKE_CHAT_ID` | Optional intake-channel exclusion used by the reader's channel manager. |
| Legacy workflow | `N8N_INGEST_SECRET`, `N8N_PUBLISH_URL`, `N8N_PUBLISH_SECRET`, `READER_CONFIG_SECRET` | Legacy draft ingestion, publishing webhook, and legacy source-list authentication. |

For local development, reader URLs normally point to `http://localhost:3000/api/ingestion/channels` and `http://localhost:3000/api/ingestion/posts`. The reader and web application must share `INGEST_READER_SECRET` (at least 32 characters). Reader `OUTPUT_CHAT_ID` must identify the same output channel as web `TELEGRAM_OUTPUT_CHAT_ID`.

Environment files, Telegram session files, and runtime databases contain private state and are excluded by the root `.gitignore`.

## Run locally on Windows

Use separate terminals for the web application, reader, and each worker. Commands below start from the repository root unless stated otherwise.

1. Install the existing locked dependencies in both application folders:

   ```powershell
   cd web
   npm.cmd ci
   cd ../telegram-reader
   npm.cmd ci
   cd ..
   ```

2. Configure PostgreSQL and OAuth, then apply migrations and generate the client:

   ```powershell
   cd web
   npx.cmd prisma migrate deploy --config ./prisma7.config.ts
   npx.cmd prisma generate --config ./prisma7.config.ts
   npm.cmd run dev
   ```

   Open `http://localhost:3000`. The account must be verified and approved, with the appropriate workspace service enabled. Apply additive migrations to existing databases; do not reset saved data.

3. From a separate terminal at the root, log in to Telegram if necessary and start ingestion:

   ```powershell
   cd telegram-reader
   node login.cjs
   node reader.cjs
   ```

   The login command saves a local Telegram session. Join the intended source channels with that account and add/enable them in the workspace dashboard.

4. From separate terminals in `web`, start the independent workers:

   ```powershell
   npm.cmd run worker:rss
   npm.cmd run worker:telegram
   ```

   Ensure Ollama is running with `gpt-oss:latest` installed. Choose a campaign at `/workspace/campaigns`, join/resume source participation in Overview and enable AI preparation in Settings, then receive new posts. Review generated drafts in that campaign?s Drafts page.

   To process at most one eligible job per worker:

   ```powershell
   npm.cmd run worker:rss:once
   npm.cmd run worker:telegram:once
   ```

For a production web build, run `npm.cmd run build` followed by `npm.cmd run start` from `web`. Workers and the reader remain separate processes. Local AI preparation and RSS do not require the legacy n8n publishing workflow to run.

## Main pages

| Route | Purpose |
| --- | --- |
| `/`, `/workspace` | Resolve the current account's entry destination. |
| `/login`, `/account-status` | Sign-in and account/service availability. |
| `/workspace/sources` | PostgreSQL source-channel dashboard. |
| `/workspace/rss?source=<id>` | Selected channel's RSS settings and feed-link management. |
| `/workspace/rss/items?source=<id>` | Original/processed posts and manual RSS editing. |
| `/workspace/campaigns` | Campaign dashboard with search, sort, grid/list and create/rename/delete-empty dialogs. |
| `/workspace/campaigns/[campaignId]` | Source participation, destination and manual publishing Overview. |
| `/workspace/campaigns/[campaignId]/settings` | Campaign AI settings and activation. |
| `/workspace/campaigns/[campaignId]/drafts` | Campaign drafts, comparison, saved review and manual publishing. |
| `/workspace/ai-settings` | Compatibility redirect to Default campaign Settings. |
| `/workspace/ai-drafts` | Compatibility redirect to Default campaign Drafts. |
| `/rss/<token>` | Token-protected RSS XML feed. |
| `/review`, `/channels` | Owner-only legacy SQLite review/publishing and source management. |
| `/users` | Owner-only account approval and workspace service permissions. |

## Validation and detailed documentation

Run from `web`:

```powershell
npx.cmd tsc --noEmit
npm.cmd run lint
npm.cmd run build
npm.cmd run check:telegram
npm.cmd run check:telegram -- --ollama
```

The default preparation check uses real PostgreSQL in a disposable schema with synthetic posts and mocked AI responses. The `--ollama` variant also verifies an actual local model request and draft creation. Session and Next.js adapters are mocked for server-action checks; authenticated browser/OAuth and real reader end-to-end checks remain manual. The check requires PostgreSQL schema-creation permission and removes its fixtures afterward.

- [AI_PREPARATION.md](web/AI_PREPARATION.md): AI migration, worker lifecycle, changed files, validation results, and manual test procedure.
- [REDESIGN.md](web/REDESIGN.md): light UI, routing, access rules, and earlier validation notes.

## Proposed future features

These are proposed next stages, not implemented capabilities or committed release dates.

| Feature | Intended behavior |
| --- | --- |
| PostgreSQL draft publishing | An explicit publishing stage for approved AI drafts, with destination configuration, idempotent claims, delivery confirmation, and recovery of uncertain sends. |
| Scheduled publishing | A workspace queue for timed delivery and editorial scheduling. |
| Multiple workspace connections | Separate Telegram reader connections and destinations instead of the initial single `INGEST_WORKSPACE_ID` connection. |
| Additional local models | Extend the explicit allowlist after validating model behavior, output quality, and local resource requirements. |
| Editorial history | Track final-text revisions and review decisions with reviewer identity and timestamps. |
| Worker operations page | Inspect queued/skipped/failed jobs, retry eligible failures deliberately, and see worker health. |
| Durable reader queue | Persist unsent ingestion records across reader restarts and longer API outages. |
| Media preparation | Capture and review supported images, captions, and attachments alongside text, with separate delivery rules. |
| Authenticated end-to-end tests | Exercise real sign-in, source ingestion, draft review, and RSS delivery in a dedicated test environment. |
| Legacy data transition | Plan an additive migration of legacy SQLite records/settings if the two workflows are eventually consolidated. |
