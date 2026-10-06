# Campaign foundation — migration for review

**Current status:** the foundation migration is applied. Default-campaign runtime compatibility is implemented; see [DEFAULT_CAMPAIGN_RUNTIME.md](./DEFAULT_CAMPAIGN_RUNTIME.md) for current writers, catch-up and rollout commands. The review and deployment notes below describe the original foundation-only stage.

`prisma/migrations/20261006150000_campaign_foundation/migration.sql` is the first additive campaign migration. Its original implementation changed only the database foundation. It did not change previously applied migrations, application queries, workers, server actions, UI, Telegram connections or receipt files, or enable multiple-campaign execution.

## Added models and relationships

`Campaign` maps to `campaign`. It contains the normal cuid-generated ID, `workspaceId`, name, `isDefault`, and creation/update timestamps. Its workspace foreign key uses `ON DELETE RESTRICT`. The unique `(id, workspaceId)` key supports workspace-qualified references. A custom partial unique index permits at most one `isDefault = true` campaign per workspace while allowing other campaigns. Names are labels, not unique identities.

`CampaignSource` maps to `campaign_source`. Its primary key is `(campaignId, sourceChannelId)`, so a source/campaign pair is unique while a source can belong to several campaigns. It stores `workspaceId`, `telegramAutomationEnabled` (default false), and timestamps. Composite foreign keys to both `(campaignId, workspaceId)` and `(sourceChannelId, workspaceId)` enforce that campaign and source belong to the same workspace. A direct workspace foreign key and indexes support workspace-scoped access. These are database constraints, not just application checks.

`AiDraft.campaignId` and `ProcessingJob.campaignId` are optional, with composite foreign keys to `(Campaign.id, Campaign.workspaceId)` and supporting indexes. A SQL check allows non-null job campaign IDs only for `TELEGRAM_PREPARE`; RSS jobs must remain null. Original posts remain shared source records; no campaign reference is added to originals, RSS feeds, or RSS items.

The new `ai_draft_campaign_immutable` trigger rejects changing or clearing a campaign once a draft has one. Null-to-assigned is permitted for the staged backfill of records still created by legacy writers. Ordinary Save/Approve/Reject updates do not change this field and continue working.

## Mapping existing records

The migration runs in a transaction. Workspace/source writes are locked during the initial mapping; adding draft/job columns also locks those tables until commit. Plan eventual deployment as a short database migration window.

For every workspace present at migration time, including empty, disabled, pending or suspended workspaces:

1. Create one campaign named `Default`, with `isDefault = true` and deterministic ID `campaign_default_<workspace ID>`. This follows the existing SQL backfill convention; future Prisma-created campaigns use cuid IDs.
2. Add every existing source to that workspace's Default campaign. Copy the source's current `telegramAutomationEnabled` value exactly, including false values and sources whose monitoring is paused. Do not change the original source setting or monitoring state.
3. Assign all existing AI drafts to Default, regardless of review or publication state. Preserve text, prompts, model, revisions and timestamps.
4. Assign all existing Telegram preparation jobs to Default, including pending, processing, completed, failed and cancelled history. Preserve attempts, claims, leases, errors, outcomes and timestamps.
5. Leave RSS jobs' campaign IDs null and leave all RSS records/settings untouched.

Only the two new reference columns change on existing rows. New campaign and membership rows receive their own timestamps; existing rows' `updatedAt` values are not advanced by the backfill.

## Why publications derive their campaign

`TelegramPublication` already has a mandatory composite foreign key `(draftId, workspaceId)` to `AiDraft`. A publication therefore derives campaign identity through its pinned draft. Adding another campaign column would duplicate that identity, introduce a possible mismatch, and require additional snapshot/backfill changes.

The draft's new immutable campaign identity makes this derivation stable once assigned. Every existing publication inherits Default through its backfilled draft. A publication created by the current runtime from a newly created, still-null draft remains unclassified until the next rollout labels that draft. The next rollout must map those legacy null records to Default before allowing additional campaign execution.

The migration performs no writes or DDL on `telegram_publication`. Publication text, destination snapshots/revisions, random IDs, status, claim tokens, receipts, message IDs/times and recovery history remain identical. The existing random-ID and draft/revision uniqueness, partial active-publication index, workspace-qualified draft foreign key, `protect_telegram_snapshot()` function and `telegram_snapshot_immutable` trigger are preserved exactly. Receipt acknowledgement continues to use the same publication IDs and tokens.

## Temporary compatibility limits

Campaign references are intentionally nullable, with no database default or automatic assignment trigger. Current ingestion and AI workers can still create jobs/drafts without a campaign ID. Current workspace/source creation also works without creating a Default campaign or membership; this migration backfills only records existing at its deployment time.

`SourceChannel.telegramAutomationEnabled` remains the live authority. The copied membership value is preparation for the next rollout; current source-setting changes are not synchronized into it. Campaign memberships are not consulted by the current workers. Workspace AI settings, activation boundaries, publishing settings, destination verification and flood waits remain unchanged and workspace scoped.

Existing uniqueness remains deliberately restrictive:

- AI drafts: `(originalPostId, workspaceId)` still allows only one draft per original/workspace. `OriginalPost.aiDraft` remains a singular relation.
- Processing jobs: `(originalPostId, type)` still allows only one Telegram preparation job per original, as well as the independent RSS job.
- Publication: all existing uniqueness and immutable snapshot protections remain in place.

Creating a second campaign or adding a source to it does not create extra drafts, jobs or sends. Neither the old runtime queries nor these existing uniqueness constraints support that behavior yet.

## Required next runtime rollout

Before executing multiple campaigns, the next rollout must:

1. Create Default campaigns/memberships for workspaces and sources added after this migration, backfill new null draft/Telegram-job references into Default, and refresh Default membership automation values from the still-authoritative source settings. Preserve already assigned draft lineage.
2. Make ingestion, job creation, preparation claims/commit checks and draft creation explicitly campaign scoped, with current workspace permission and campaign membership/automation checks. Pin campaign identity through claims and generation; do not silently retag work in flight.
3. Replace the one-draft-per-original constraint with campaign-aware uniqueness and change `OriginalPost.aiDraft` to a collection. Replace job uniqueness with separate guarantees for one RSS job per original/type and one Telegram job per original/type/campaign. Keep RSS outside campaign execution.
4. Require campaign identity for all drafts and Telegram jobs after legacy writers have been retired and the catch-up backfill is complete. Job nullability remains necessary for RSS; use a type-dependent SQL check rather than making every job's campaign ID mandatory.
5. Add campaign-aware settings and migrate existing Default settings/revisions/activation boundaries deliberately. Define campaign publishing destinations, source eligibility and scheduling before updating publication claims/authorization and UI filtering. Current workspace settings stay authoritative until then.
6. Preserve publication snapshots, random IDs, receipt replay and uncertainty recovery across the transition. Review workspace-wide send serialization and Telegram account flood-wait handling before introducing any campaign concurrency. Existing published drafts must retain their original campaign identity.

Those changes, automatic publishing and additional Telegram logins are outside this migration.

## Validation and commands

From `web`, review the schema and run the isolated migration/history check:

```powershell
npx.cmd prisma validate --config ./prisma7.config.ts
npx.cmd tsc --noEmit
npm.cmd run check:campaign-migration
npm.cmd run check:publishing
npm.cmd run check:telegram
```

`check:campaign-migration` creates a UUID-named disposable PostgreSQL schema, applies the seven old migrations, seeds synthetic legacy history, and only then applies the new campaign migration in that schema. It compares every legacy field before/after, compares publication index/trigger/function definitions, checks workspace foreign keys and uniqueness, tests immutable lineage and RSS exclusion, and exercises the unchanged preparation/publishing/receipt functions without Telegram calls. It checks that the main schema's campaign-table presence and migration history are unchanged, then drops only its own disposable schema in `finally`.

The check works with either the current or the staged Prisma Client: legacy draft/job seeding uses SQL before their campaign columns exist, and runtime compatibility checks use Prisma after the isolated migration. It requires PostgreSQL permission to create/drop a schema. It never starts the reader or reads live receipt/session files.

During implementation, the updated Prisma Client was generated to a temporary separate location. Its generated types and legacy create payloads were checked with TypeScript, and the existing application was also type-checked against that staged client using a compiler file mapping. The current application's generated client was left unchanged because the main database does not yet have the new columns. Do not regenerate the application's client against this new schema before the migration is approved and deployed: it could query columns absent from the main database.

Validation passed: Prisma schema validation, staged client generation/type checks, migration-to-schema diff (empty), TypeScript, lint of the new check, populated-schema migration tests, and the existing mocked AI/publishing/RSS integration checks. Disposable schemas and generated validation artifacts were removed. No database reset or main-database migration was performed and no changes were pushed.

After review and explicit deployment authorization, migration deployment and application-client generation must be coordinated. **Do not run `prisma migrate deploy` on the main database as part of reviewing this stage.**
