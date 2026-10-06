j# Default campaign runtime compatibility

The campaign foundation is already deployed. This rollout keeps the single-workspace execution behavior and workspace AI/publishing settings. It adds no schema migration, campaign UI, automatic publishing or Telegram login. Legacy `/review` and RSS stay independent.

## Runtime writers

`src/lib/default-campaign.ts` supplies transaction helpers. `ensureDefaultCampaign` uses duplicate-safe insertion and the existing partial unique index, then reads the winning Default. It does not rely on the label or a deterministic ID. A workspace can have only one Default. Concurrent transactions at the normal isolation level converge on it; ingestion retains its existing serializable-conflict retry.

`src/app/actions/users.ts` creates the Default in the same transaction that approves a user and creates or updates their workspace. Reapproval repairs a missing Default without touching settings or membership history. Other workspace creation paths do not exist in the current runtime.

`src/app/actions/sources.ts` adds a Default membership in the source creation transaction, including duplicate submissions. Telegram automation changes update the source and synchronize its Default membership in one transaction. Source rows are locked before reading their flags. `SourceChannel.telegramAutomationEnabled` remains authoritative; another campaign's membership is untouched. Monitoring and RSS toggles do not enable Telegram automation.

`src/app/api/ingestion/posts/route.ts` ensures Default membership after validating the authenticated workspace and source. New Telegram preparation jobs receive that Default ID; RSS jobs explicitly receive null. Existing duplicate-original behavior is retained: no job is reset or recreated. Creating a job while source automation is off preserves the existing pause/resume queue behavior; the worker cannot claim it until the source is eligible.

`scripts/telegram-processing.ts` claims only workspace-qualified Default jobs. The claim contains campaign identity; every ownership check includes workspace, original and campaign as well as the lease token. Before generation and commit, the worker checks Default identity and workspace-qualified original/source consistency. A new draft receives the claimed ID. Existing drafts keep their text, revisions and campaign; inconsistent lineage fails safely rather than retagging a draft. Database workspace foreign keys and the immutable draft-campaign trigger remain authoritative. Activation times, attempts, bounded retries and pause/refund behavior are unchanged.

`src/lib/publishing-db.ts` and `src/app/api/reader/publishing/route.ts` require Default identity for queuing, claiming and immediately authorizing sends. Unassigned drafts require catch-up; other campaigns cannot dispatch. No campaign reference is duplicated on publications: identity derives from their immutable draft. Receipt acknowledgement and recovery deliberately do not require campaign eligibility, so an existing send can still settle after access or settings change. Publication text/destination snapshots, random IDs, tokens, uniqueness protections, journal replay and uncertainty handling are unchanged. Disabling a setting cannot recall an in-flight send.

## Catch-up and stopped-worker rollout

`scripts/default-campaign-catchup.ts` reports counts by default. Applying requires `--apply --workers-stopped`; this flag is an operator acknowledgement, not automatic process detection. The operation obtains bounded table locks and runs atomically. It:

- Creates missing Defaults and missing Default memberships for all workspaces/sources, including suspended or disabled ones.
- Copies authoritative source automation values into Default memberships only.
- Assigns only null draft and Telegram-job campaign references. Existing assigned identity is never changed; conflicting draft/job lineage causes the whole catch-up to roll back.
- Preserves old timestamps and all job statuses, attempts, locks, leases, errors and outcomes. New membership timestamps come from its source. RSS jobs/data and publication rows are never written.

Repeated application returns zero changed counts. Catch-up is not part of worker startup and must run with writers stopped. A null job is left unclaimed until catch-up; a null draft cannot be newly queued or dispatched. Existing delivery receipts can still be recorded.

Run these PowerShell steps with the existing environment configuration. The foundation migration is already applied; do not reset or reapply it.

1. Stop the website, Telegram preparation worker, RSS worker and Telegram reader in their existing terminals with **Ctrl+C**, and wait for shutdown. Also stop any deployed instances of those processes. Allow an in-flight generation/send to finish its normal shutdown path. Preserve the reader's session and receipt journal. Do not change AI settings to simulate shutdown: their revision and activation rules should remain intact.
2. From `web`, deploy this code and generate the client, then inspect and apply catch-up:

```powershell
npx.cmd prisma generate --config ./prisma7.config.ts
npm.cmd run campaigns:catch-up -- --check
npm.cmd run campaigns:catch-up -- --apply --workers-stopped
npm.cmd run campaigns:catch-up -- --check
```

All final gap/conflict counts must be zero. Investigate failures while processes remain stopped; do not clear job leases or modify publication snapshots. Repeating the apply command is safe. The CLI prints counts and a generic failure message, without database URLs, session credentials or post text.

3. Build and restart the website, then restart workers in separate terminals:

```powershell
# web: production website terminal
npm.cmd run build
npm.cmd run start
# web: separate preparation worker terminal
npm.cmd run worker:telegram
# web: separate RSS worker terminal
npm.cmd run worker:rss
```

For local development use `npm.cmd run dev` instead of production build/start. Restart the existing connected reader last, from `telegram-reader`:

```powershell
node reader.cjs
```

Restarting the reader can send already authorized queued publications. These are rollout commands for the operator, not automated validation commands. If delivery is uncertain, use the existing explicit recovery workflow; never expire/reset a lease to force a resend. A success stored in the reader's receipt journal is retried against the website without sending again, even after restart or temporary website unavailability.

## Validation

From `web`:

```powershell
npx.cmd prisma validate --config ./prisma7.config.ts
npx.cmd tsc --noEmit
npm.cmd run lint
npm.cmd run check:campaign-runtime
npm.cmd run check:campaign-migration
npm.cmd run check:telegram
npm.cmd run check:publishing
```

From `telegram-reader`:

```powershell
npm.cmd test
```

Integration checks use UUID-named disposable PostgreSQL schemas and synthetic records, then remove only those schemas. The runtime check invokes actual workspace approval, source actions and ingestion with mocked session/Next boundaries. It tests competing Default creation, transactional toggle sync, Default job/draft identity, duplicate ingestion, RSS nullability, workspace foreign keys, historical field/lease preservation, idempotent catch-up, transactional conflict rollback, changed claim identity and refusal to execute other campaigns. Existing preparation tests cover activation, access revocation, pause/resume and stale results. Existing publishing and mocked reader checks cover immutable snapshots, double clicks, concurrent claims, flood waits, uncertain delivery, recovery and successful send followed by acknowledgement failure. No live Telegram calls or receipt/session files are used.

## Later migration

Nullable references remain for legacy compatibility; draft uniqueness `(originalPostId, workspaceId)` and job uniqueness `(originalPostId, type)` are unchanged. After old writers are retired, a later migration can require campaign identity for drafts and Telegram jobs while retaining RSS nulls. Multiple-campaign execution still requires campaign-specific settings/activation, membership authority, campaign-aware draft/job uniqueness and original-post relations, scoped UI and publication eligibility. Preserve assigned lineage and delivery protections through that transition.
