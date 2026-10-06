# Campaign-aware execution

This change supports one Telegram preparation job and draft per eligible campaign for a single stored original. Current website routes still configure and display **Default only**. Publishing remains an explicit manual operation on a saved, approved draft. There is no campaign-management UI, automatic publishing, bot, n8n dependency in this path, or additional Telegram login.

The campaign foundation and campaign settings migrations are prerequisites. `AI_PREPARATION.md`, `DIRECT_PUBLISHING.md`, and the earlier campaign rollout documents were not present in this checkout when this implementation was inspected; the schema, applied SQL migrations, reader, workers, actions, and existing checks were used as the current specification.

## Database and transition

Review `web/prisma/migrations/20261006220000_multi_campaign_execution/migration.sql`. It is a new, transactional migration; no applied migration was edited. It has not been applied to the main development database.

| Change | Purpose |
| --- | --- |
| `Campaign.executionStartsAt` | Immutable UTC execution boundary assigned by PostgreSQL's clock when a campaign is created. |
| `CampaignSource.eligibleAfter` | Immutable UTC boundary assigned when a source joins a campaign. |
| `CampaignSource.revision` | SQL-managed participation revision; off/on changes increment it, so an AI result spanning a pause cannot commit even if participation has resumed. |
| Required `AiDraft.campaignId` | Retains the composite `(campaignId, workspaceId)` foreign key and immutable campaign assignment. Uniqueness becomes `(originalPostId, campaignId)`. |
| `OriginalPost.aiDrafts` | A collection referencing the same original text rather than storing copies for each campaign. |
| Conditional job identity | SQL requires a non-null campaign for `TELEGRAM_PREPARE` and null for `RSS_PREPARE`. The triple unique index prevents duplicate campaign jobs; a partial RSS unique index prevents duplicates despite SQL's nullable-key semantics. |

The migration locks the affected tables and rejects missing Defaults, missing Default memberships, unassigned drafts/Telegram jobs, or conflicting historical draft/job lineage. Run the checked catch-up with all services stopped before attempting deployment. Existing assigned IDs are never changed. New lineage triggers also reject reassignment of job identity/type/campaign and draft identity/workspace/original; the existing draft-campaign trigger remains intact. Attempts, statuses, leases, historical timestamps, settings activation/revisions, publication text/destination snapshots, random IDs, receipts, and recovery data are not reset.

Existing Default campaigns and memberships receive `0001-01-01` boundaries. This preserves their existing `receivedAt > activatedAt` rule and all previously queued publications. Existing non-Default campaigns and memberships retain their stored creation/join timestamps as boundaries; newly created rows get a fresh boundary. Boundaries explicitly use `timezone('UTC', clock_timestamp())`, matching Prisma's timestamp storage even when PostgreSQL uses a non-UTC session timezone.

Publications continue deriving campaign identity through their workspace-qualified draft relationship. The draft now has a required, immutable campaign identity, so a second publication campaign column would add redundant identity and require rewriting historical rows. Existing publication uniqueness indexes and immutable-snapshot triggers are unchanged. Workspace/source/original composite keys and foreign keys remain; original ingestion uniqueness is unchanged. The workspace's partial one-Default index remains authoritative for concurrent Default creation.

The old source automation column remains as frozen historical data. A trigger rejects changing it. Membership writes use the transaction-local `app.campaign_membership_writer` marker through `setCampaignMembership`; a trigger blocks obsolete SQL synchronization from changing campaign choices. This is protection against accidentally running old maintenance code, not a substitute for database administrator access controls.

## Eligibility and pause/resume

An original is eligible for AI in a campaign only when its server `receivedAt` is **strictly later** than all three boundaries: campaign creation/cutover, membership creation, and the campaign's first AI activation. Equal timestamps are excluded. Telegram's publication date does not determine eligibility. Boundaries do not move when settings are saved or participation resumes.

Ingestion stores the original once and creates at most one RSS job. For explicitly assigned memberships with an established activation boundary, it records eligible future Telegram jobs even while participation or campaign AI settings are paused. Those jobs remain pending; pausing never starts AI generation. Unactivated campaigns receive no Telegram jobs. Duplicate ingestion returns the existing original and does not import history or create jobs for memberships added later.

Resume processes retained, eligible pending jobs, including eligible originals collected during a campaign/member pause. It does not sweep historical originals. Removing a membership and creating it again establishes a new future boundary; use its participation toggle to pause without losing that boundary. `SourceChannel.enabled` remains the monitoring control: no collection while it is off, and no generation or dispatch from that source. Workspace automation disablement preserves existing jobs but does not enqueue new Telegram jobs while disabled; RSS remains governed independently by workspace RSS permission.

New campaigns and memberships are disabled by default. Campaign AI settings and publishing settings remain authoritative; legacy workspace settings remain frozen. The current source-page toggle controls **Default membership only**, and its text explains retained queued work and independent RSS. It never copies the obsolete source flag back into membership.

AI claims filter by the explicit job campaign, approved/verified owner, workspace automation permission, monitoring, enabled membership, campaign AI enablement, activation and eligibility boundaries. Generation runs outside database locks. Before committing, the worker rechecks claim token/lease/original/workspace/campaign identity, settings revision, membership revision and eligibility. A settings change or off/on cycle discards the result and refunds the attempt. A disabled campaign's jobs are filtered before selection so they cannot block another eligible campaign.

## Publishing and reader protocol

The reusable queue helper reads settings through the draft's campaign. Current Publish actions additionally require Default identity. Approval and saved revision must match; the publication captures the exact text, destination, destination revision and stable random ID. Campaign changes never redirect that snapshot. A changed destination revision fails the old queued snapshot when it becomes eligible; publishing to the new destination requires a newly saved and approved draft revision.

Eligibility for publication requires approved workspace/account automation access, monitored source, enabled membership and enabled, verified campaign publishing settings. Future-only boundaries govern creation of AI work; they do not retroactively invalidate an existing approved draft or publication snapshot. AI generation enablement does not gate manually publishing an existing approved draft. The reader reauthorizes immediately before invoking Telegram. A pause before the Telegram call returns the same snapshot to `QUEUED` via the `paused` result. Definite Telegram rejection becomes `FAILED`; a possible send becomes `DELIVERY_UNKNOWN`. Disabling any setting cannot recall a send already in flight.

The authenticated reader endpoint returns protocol version 2 with a bounded `verifications` list. Each request/result includes campaign ID, username and settings revision; ownership and revision are checked server-side. The reader resolves up to three destinations per polling tick using its existing client. All configured campaign destinations, including disabled ones, are excluded from monitored sources by username and stable chat ID. The channel manager also excludes aliases resolving to these IDs; ingestion rejects such aliases before binding/storing the post. Destination verification rejects an already known source identity.

Workspace/account-wide serialization, flood waits, journal receipt replay, stable Telegram request IDs and uncertain-delivery barriers remain shared across campaigns. The reader flushes its local receipt journal before claiming more work. If Telegram accepts a send but the website is unavailable, the successful receipt remains on disk and acknowledgement is retried without sending again. A website claim that expires becomes delivery-unknown; a later valid receipt can settle it. Never delete the reader's journal to clear a queue.

Acknowledgement remains independent of campaign enablement and accepts valid late receipts even after owner access is suspended. Recovery also does not require enabled campaign settings: `requestPublicationRecovery` checks workspace ownership/access and explicit campaign lineage, then requests exact-message verification or records a confirmed no-send decision. Current UI recovery stays Default-only; the reusable server helper supports future campaign routes. Recording an existing message must verify outgoing status, exact snapshot text and stable channel. Confirming no send requires stopping the reader, inspecting Telegram, and waiting at least ten minutes after dispatch. Retrying a confirmed unsent snapshot preserves its random ID. A delivery-unknown publication blocks sends from every campaign in the workspace until resolved.

## Changed files

| Files | Responsibility |
| --- | --- |
| `web/prisma/schema.prisma`, new migration | Campaign uniqueness, required/conditional identity, UTC boundaries, membership authority safeguards. |
| `web/src/lib/campaign-execution.ts`, `campaign-settings.ts` | Scoped ownership, membership writes/boundaries, destination conflicts, safe disabled campaign creation/settings. |
| `web/src/lib/default-campaign.ts`, `default-campaign-catchup.ts` | Concurrent Default creation, safe off-by-default membership creation; pre-cutover catch-up uses raw SQL compatible with the deployed schema and refuses writes after cutover. |
| `web/src/lib/ai-db.ts`, `web/scripts/telegram-processing.ts` | Explicit campaign settings, locks, per-campaign claims and generation/commit checks. |
| `web/src/app/api/ingestion/posts/route.ts`, `channels/route.ts` | One original, independent RSS job, campaign fan-out, all-destination exclusions. |
| `web/src/lib/publishing-db.ts`, reader publishing API | Campaign snapshots, dispatch eligibility, shared coordination, scoped verification, paused result and reusable recovery. |
| `telegram-reader/publisher.cjs`, `channel-manager.cjs` | Multiple verification requests and destination exclusions with the existing Telegram session/client. `reader.cjs` requires no change. |
| Source/AI/publishing actions, source/draft pages, `campaign-drafts.ts` | Default-only settings, toggles, mutations, paginated lists and preparation failures; reusable scoped draft queries. |
| Integration scripts, staged validation helper, reader tests, package scripts | Disposable populated transition and runtime checks; staged Prisma Client support and optional production build. |
| `web/scripts/audit-campaign-execution.ts` | Read-only post-cutover counts; never copies source automation flags. |

Legacy `/review`, RSS code/data, dependencies and session/login code are unchanged. The historical foundation/runtime test scripts retain their old transition fixtures (raw SQL where nullable legacy drafts must be constructed); use the new staged execution suite for the current runtime rather than interpreting their pre-cutover authority assumptions as current behavior.

## Review validation commands

Use Node 24 (the staged import resolver uses `registerHooks`). From the repository root, with installed locked dependencies and configured local PostgreSQL:

```powershell
Set-Location web
npm.cmd run check:campaign-execution:staged
npm.cmd run lint
Set-Location ../telegram-reader
npm.cmd test
Set-Location ../web
npm.cmd run check:campaign-execution:staged -- --build
Set-Location ..
```

The staged command generates separate proposed and pre-execution clients under ignored `.campaign-settings-validation`, checks TypeScript, applies SQL only to randomly named disposable schemas, runs mocked AI integrations and publishing checks, and drops those schemas. It checks main migration history is unchanged. No live Telegram connection or AI request is used. RSS integration executes the existing worker against its disposable schema.

The `--build` option requires website/workers to be stopped: it temporarily swaps the generated client directory, runs Next's build, and restores the complete original directory in `finally`. Do not run the resulting build against the old database. If the process is forcibly killed during the swap, restore `.campaign-settings-validation/build-original` to `src/generated/prisma` before starting the old application. After eventual deployment, regenerate and rebuild normally against the deployed schema.

Checks cover populated queued/published/unknown history, immutable publication definitions, catch-up rollback/idempotence/retirement, concurrent Defaults and duplicate ingestion, two prompts/destinations sharing an original, future-only membership/campaign boundaries, Default-only actions/listing, membership pause/resume and revision cycles, settings changes during generation, cross-workspace foreign keys, independent RSS, suspension/disabled access, lease recovery, destination errors, shared flood waits, receipt acknowledgement failure/restart, and exact-message recovery. The reader tests use mocked Telegram and HTTP calls.

## Proposed stopped-service rollout (not executed)

The latest live settings-cutover test is still unconfirmed. Keep that as an operational gate: confirm the existing Default settings workflow before authorizing live restart with this change. The initial copy parity command is intended immediately after settings copy; do not compare the frozen workspace copies after intentional campaign setting changes and call those differences corruption.

1. Stop **all** website instances, Telegram preparation workers, RSS workers and reader instances using their existing service manager, or press Ctrl+C in each running development terminal. Wait for worker/reader shutdown and in-flight work to settle. Keep the existing reader receipt journal and session intact. Take the usual database and journal backup. Do not run the older runtime against the new constraints.
2. With services still stopped, install this code but retain the deployed client until catch-up and migration are done. Run these exact commands from the repository root. Check every exit code before proceeding:

```powershell
Set-Location web
npm.cmd run campaigns:catch-up -- --check
npm.cmd run campaigns:catch-up -- --apply --workers-stopped
npm.cmd run campaigns:catch-up -- --check
# All catch-up gap/lineage counts must now be zero.
npx.cmd prisma migrate status --config ./prisma7.config.ts
npx.cmd prisma migrate deploy --config ./prisma7.config.ts
npx.cmd prisma generate --config ./prisma7.config.ts
npm.cmd run campaigns:audit-execution
npx.cmd tsc --noEmit
npm.cmd run lint
npm.cmd run build
```

The only pending migration for this rollout should be `20261006220000_multi_campaign_execution`; investigate unexpected pending migrations before `deploy`. The post-cutover audit must show zero identity/membership gaps. It also reports missing settings/coordination rows, which use safe disabled defaults when initialized by runtime helpers; investigate unexpected counts before restart. Once cut over, `campaigns:catch-up -- --apply --workers-stopped` deliberately fails. `--check` is read-only; `campaigns:audit-execution` is the ongoing read-only command. Never rerun source-flag synchronization SQL to repair memberships.

3. Only after checks and the outstanding operational gate are satisfied, start the upgraded website and workers in separate terminals (each starting from the repository root):

```powershell
# Terminal A
Set-Location web
npm.cmd run start

# Terminal B
Set-Location web
npm.cmd run worker:telegram

# Terminal C
Set-Location web
npm.cmd run worker:rss

# Terminal D, only when live reader restart is authorized
Set-Location telegram-reader
node reader.cjs
```

Restarting the reader can dispatch previously queued manual publications; it is not a no-send test. This implementation ran neither these rollout commands nor any live send. Do not create live test campaigns in the development database. Use the disposable fixtures to test extra campaigns until campaign-management access/UI work is authorized.

Rollback requires keeping services stopped and using a coordinated database/code backup or a separately reviewed forward fix. Old writers and the old reader protocol are incompatible with the new campaign constraints/paused result. Do not remove constraints, clear uncertain jobs, edit applied migrations, or restore only application code while leaving the new database active.

## Later work

Campaign management must call the scoped helpers after obtaining approved workspace access, preserve immutable creation/membership/activation boundaries, maintain settings revisions, and expose scoped editing/recovery routes rather than broadening Default routes. Account coordination stays workspace-wide. Automatic publishing, more Telegram accounts and campaign UI remain separate tasks.
