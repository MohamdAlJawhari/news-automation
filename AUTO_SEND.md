# Campaign Auto-send

Auto-send is off for every existing and newly created campaign. Publishing enablement remains a separate prerequisite. Overview requires an explicit checkbox confirmation identifying the verified destination and explaining that future eligible posts publish without human review, while existing drafts remain manual. Drafts shows campaign mode, automatic approval separately from actual publication, manual-attention reasons, and publication origin.

## Schema and flow

The new migration is `web/prisma/migrations/20261007220000_campaign_auto_send/migration.sql`. No earlier migration is edited. It adds:

| Model | Fields / behavior |
| --- | --- |
| Campaign | `autoSendEnabled`, `autoSendActivatedAt`, `autoSendGeneration`, `autoSendRevision`. SQL starts every campaign off, increments revision on either transition and assigns a fresh UTC boundary/generation on every OFF → ON. Ordinary saves cannot move these values. |
| ProcessingJob | Immutable nullable `autoSendGeneration`, assigned by SQL only on insertion of a Telegram job whose original `receivedAt` is strictly after the enabled campaign boundary. Existing jobs and RSS jobs retain null. |
| AiDraft | `approvalMode`, `autoSendGeneration`, `manualAttentionReason`. Existing approved drafts are marked MANUAL; existing draft generations remain null. |
| TelegramPublication | `deliveryMode`, immutable `queuedAutomatically` and `autoSendGeneration`. Existing publications remain MANUAL. A deliberate manual retry can change delivery mode to MANUAL, preserving automatic origin, text, destination and random ID. |

Ingestion keeps its existing fan-out, duplicate protection and pause rules. The SQL insertion stamp records the activation at receipt/job creation rather than at draft creation or AI claim. Off-period jobs and earlier-generation jobs cannot become eligible when enabled later. Duplicate ingestion never stamps old jobs again.

The AI worker captures job generation and publishing destination revision before its mocked/real Ollama call. Existing AI claim, lease, settings and membership revision checks remain. Valid newly generated text is inserted once; existing drafts, human edits and review decisions are never auto-reviewed. Under the existing owner/workspace/membership/source/AI/publishing locks, the worker rechecks access, connected workspace, membership, enabled AI and publishing, verified destination, original received boundary and activation identity. It approves AUTOMATIC and calls the same queue helper in that transaction. Queue failure rolls back approval and draft insertion; the existing job retry can prepare it again without duplicate publication.

An Auto-send transition or destination change during generation preserves the otherwise valid prepared draft as pending review with a reason. Off/manual campaigns also retain manual drafts. Oversized Telegram text remains for editing. Existing AI eligibility revocation rules are retained: access/AI/settings/membership changes that invalidate AI preparation itself discard the AI result, refund its attempt and retain the pending job for permitted resume; they do not approve or queue it. This is distinct from an otherwise valid AI draft becoming ineligible for automatic delivery.

The reader remains the only Telegram sender. Claim and immediate authorization both recheck current Auto-send generation, original received boundary and enabled AI for automatic publications, in addition to the existing current access, membership, monitoring, publishing, verified destination and exact snapshot checks. Manual publications retain their existing eligibility rules, including publishing already approved drafts while AI is paused.

Turning Auto-send off marks QUEUED automatic publications FAILED with a manual-attention reason. Automatically approved drafts remain approved and available for deliberate manual Publish. Claimed SENDING entries are not rewritten: immediate authorization refuses them after disablement, the reader returns its existing paused result, and a subsequent claim retires the stale automatic queue. Entries in an older generation never resume automatically. An authorized/in-flight send cannot be recalled. Receipts, lease expiry to DELIVERY_UNKNOWN, explicit exact-message/no-send recovery, journal replay, workspace-wide serialization/flood waits and stable random IDs remain unchanged. Unknown delivery never retries automatically; a manual retry requires the existing confirmed-no-send recovery first. No destination change redirects a saved snapshot.

## Changed files

- `web/prisma/schema.prisma` and the new migration: safe defaults, activation transitions, ingestion generation stamping, provenance constraints.
- `web/src/lib/auto-send.ts`, `web/src/app/actions/auto-send.ts`: scoped, confirmed transitions and atomic automatic review/queue orchestration.
- `web/src/lib/publishing-db.ts`: shared transaction-capable queue helper, claim/authorization checks, deliberate manual retry mode.
- `web/scripts/telegram-processing.ts`: capture preparation identity and auto-queue only freshly created eligible drafts.
- `web/src/app/actions/ai.ts`: manual approval provenance and clearing obsolete manual-attention feedback on a human decision/edit.
- `web/src/components/AutoSendControl.tsx`, campaign Overview and Drafts pages: destination confirmation, current mode and separate approval/delivery feedback using existing white-theme components.
- `web/scripts/check-auto-send.ts`: disposable PostgreSQL integration with mocked AI and Telegram receipts; boundary, race, rollback/retry, permissions and recovery coverage.
- Staged execution harness and transition regression: retain historical execution migration testing while applying later migrations in disposable schemas.
- `web/scripts/check-auto-send-build.ts`, browser regression and package scripts: isolated build and interactive confirmation validation. Running application client/build are preserved.

RSS code/data, legacy `/review`, reader protocol/session, dependencies and single-workspace Telegram connection are unchanged.

## Validation commands

Use Node 24 on PATH. From `web`, with installed locked dependencies and local PostgreSQL configured:

```powershell
npm.cmd run check:campaign-execution:staged
npm.cmd run lint
# Includes TypeScript against the separate proposed client; no live client regeneration.
node --import ./scripts/staged-campaign-client.mjs --import tsx scripts/check-campaign-ui.ts
npm.cmd run check:auto-send:build
$env:CAMPAIGN_UI_BUILD = Get-Content .campaign-ui-validation/build-path.txt
npm.cmd run check:campaign-ui:browser
Remove-Item Env:CAMPAIGN_UI_BUILD
Set-Location ../telegram-reader
node --test publisher.test.cjs
```

`check:auto-send` can rerun just the new suite after the staged client has been generated. The full suite also covers independent RSS processing, immutable snapshots, source/destination alias exclusions, concurrent claims, stale leases, duplicate ingestion, human review races, uncertain recovery and reader receipt replay. SQL is applied only in random disposable schemas which are dropped afterward; main migration history is compared before/after. No Telegram session/login or Ollama network call occurs in these regressions. The isolated production build uses webpack and a proposed generated client in an ignored copy, leaving running services untouched. Do not deploy its output against an old database.

## Rollout (not executed)

Validation completed on 2026-10-07: staged TypeScript, lint, isolated production build, campaign execution/preparation/publishing/RSS regressions, expanded Auto-send integration (including queue-failure rollback/retry), campaign UI integration, offline desktop/mobile browser checks including explicit Auto-send confirmation, and all nine mocked reader tests passed. `git diff --check` passed. The authenticated smoke test below was documented, not executed; the existing campaign UI manual gate is supplied by the user.

The authenticated manual campaign UI gate has passed according to the current handoff. This change still needs migration and matching website/worker deployment. If the earlier execution/settings migrations are not already deployed, follow their documented prerequisites first; do not blindly deploy an unexpected list of pending migrations.

1. Stop all website instances, Telegram AI workers, RSS workers and reader instances using the existing process manager. Allow authorized sends to settle; keep the session and receipt journal. Back up database and reader journal together. Inspect/resolve unknown deliveries using existing recovery procedures.
2. Install this reviewed code while stopped. From the repository root:

```powershell
Set-Location web
npx.cmd prisma migrate status --config ./prisma7.config.ts
# Expected new pending migration: 20261007220000_campaign_auto_send only.
npx.cmd prisma migrate deploy --config ./prisma7.config.ts
npx.cmd prisma generate --config ./prisma7.config.ts
npm.cmd run campaigns:audit-execution
npx.cmd tsc --noEmit
npm.cmd run lint
npm.cmd run build
```

Inspect each exit code. No catch-up, settings copy or backfill of Auto-send eligibility is needed. Existing campaigns, jobs, drafts and manual queues retain safe manual behavior. Verify every campaign is off after migration. Deploy the matching website and AI worker together. Reader code/protocol has not changed but its restart can dispatch existing manual queues.

3. Restart the website (`npm.cmd run start` in `web`), AI worker (`npm.cmd run worker:telegram`), RSS worker (`npm.cmd run worker:rss`) and existing reader (`node reader.cjs` in `telegram-reader`) through the existing process manager, only when sending is authorized. Verify destination/access and explicitly confirm Auto-send separately for each intended campaign. Do not enable it by SQL or copy one campaign's settings to others.

Operational disablement is per campaign Overview → Turn Auto-send off. This preserves records and stops automatic work awaiting authorization. Manual queues can still dispatch; already authorized/in-flight sends and durable receipts can still settle. Re-enabling is a new future boundary, so stopped/older jobs and prepared drafts require manual review/publishing.

Rollback before migration is restoring code only. After migration, turn Auto-send off everywhere and stop all services before rollback analysis. The old application can ignore added columns but its publisher does not enforce automatic provenance/generation: **code-only rollback can send leftover automatic queues or paused claimed entries**. Use a reviewed forward fix or coordinated pre-rollout database/code/journal restoration after reconciling any actual Telegram sends. Restoring a database does not undo Telegram deliveries; never restore/erase a journal or unknown history blindly, remove constraints, change stable random IDs, or automatically resend uncertain entries. Prisma deploy does not provide a down migration here. Dropping columns loses provenance and activation boundaries; no destructive rollback migration is supplied.

## Runtime diagnosis and UI fixes (2026-10-08)

A read-only check of the main database found the execution migration applied but `20261007220000_campaign_auto_send` absent, no Campaign Auto-send columns, and the active generated Prisma source missing Auto-send fields. Restarting alone cannot activate this feature. The previous UI treated a missing revision as a stale edit and showed “Auto-send changed”; it now suppresses activation with an explicit migration/client rollout message. Follow the stopped-service rollout above only after authorization to migrate the main database.

The reported publishing toggle saved OFF in the database, but React's action-form reset restored the checkbox's initial browser state. Remounting that controlled checkbox when its saved value changes keeps the native reset baseline aligned with the saved state. Offline browser regression now saves both ON and OFF and checks the visible checkbox after action completion. The label is now “Enable Telegram publishing,” with an explanation that this gate applies to manual and automatic delivery.

“Awaiting connection” was based only on a null SourceChannel Telegram ID, not reader connection telemetry. That identity is recorded on the first ingested new post. The display now says “No posts received yet” and points to reader-terminal access/exclusion errors. The observed `@bintjbeilnews` source is bound and has received a post; `@news_intake` remains unbound. Reader/API credentials match and source-list GET succeeds. The reader deliberately excludes its configured intake/output identities and needs membership in a broadcast source. Without resolving the unbound source or its reader log, its exact exclusion/access reason is not established; no live Telegram lookup or send was performed.

The fixes are source changes requiring deployment. The main migration/client and running services were not changed during diagnosis.

The latest Telegram preparation job also reported “Ollama connection or response failed.” A read-only GET of the configured local Ollama model-list endpoint was unreachable, so AI preparation currently has a separate service-availability problem. No generation request was made and Ollama was not started or reconfigured. UI fixes passed lint, TypeScript/isolated production build, offline browser regressions and the disposable Auto-send suite. The future-boundary fixture was made deterministic to avoid receiving a synthetic post in the same millisecond as activation.

## Short manual check

In the isolated authenticated test deployment, use your existing test source and verified test destination. Synthetic fixtures use `@news_source_test` → `@news_output_test` (`-10012345`); these are mock identities, not a claim about the live channels. Check the actual displayed destination before confirmation. Keep Telegram/Ollama mocked for this validation.

1. Assign the same test source to Manual and Automatic campaigns, resume participation, enable AI and publishing, and verify each test destination. Confirm both Auto-send modes start off. Prepare a draft and retain a queued old job before activation.
2. Enable Auto-send only in Automatic. Read the destination and future-only explanation, confirm explicitly, then deliver a new mock source post. Automatic should show Automatically approved plus a queued publication, and Published only after a mocked receipt. Manual should remain pending review. Existing drafts/jobs must not publish automatically.
3. Hold the mock reader before authorization, deliver another post, and turn Auto-send off. Its automatic queue must not send; its draft/history remains. Deliberately Publish the approved draft manually and check the same snapshot/random ID is reused. A separately queued manual publication must survive disablement.
4. Hold AI generation, switch OFF → ON, then release the result: it must require manual attention. Deliver a fresh post after reactivation and check only that post auto-queues. Simulate unknown delivery, disable Auto-send and replay a valid receipt/recovery: it must settle once without a resend. Check the independent test RSS item still processes.

No main migration, live Telegram message, service restart or push is part of this implementation session.
