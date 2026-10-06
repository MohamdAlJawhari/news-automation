# Direct Telegram publishing

Default-campaign runtime assignment and stopped-worker catch-up are documented in [DEFAULT_CAMPAIGN_RUNTIME.md](./DEFAULT_CAMPAIGN_RUNTIME.md). Workspace settings and source automation remain authoritative; only Default campaign drafts/jobs execute in this stage.

Manual publishing lives at `/workspace/ai-drafts`; destination settings live at `/workspace/publishing`. It uses the existing connected owner workspace (`INGEST_WORKSPACE_ID`) and the existing teleproto user session owned by `telegram-reader/reader.cjs`. Zulfyh owns the intended test destination, `@news_output_test`. No bot, n8n, automatic publishing, or additional Telegram login is involved. Legacy `/review` and its SQLite publishing controls remain separate. RSS preparation and feeds remain independent.

## Setup and migrations

The additive migration `prisma/migrations/20261006120000_direct_telegram_publishing/migration.sql` was applied to the configured PostgreSQL database during implementation. Prisma Client was regenerated. No database reset was performed. For another deployment, run from `web`:

```powershell
npx.cmd prisma migrate deploy --config ./prisma7.config.ts
npx.cmd prisma generate --config ./prisma7.config.ts
npm.cmd run dev
```

The migration adds publishing settings, per-source `telegramAutomationEnabled`, and publication records with workspace-qualified draft foreign keys. A partial unique index allows at most one queued, sending, uncertain, or published record per draft; another unique index identifies each draft revision. A database trigger prevents changing the saved publication snapshot. Preserve these custom SQL protections in future migrations.

Publishing settings and every source's Telegram automation toggle start **off**, including existing sources. Monitoring and RSS toggles retain their existing values. AI preparation now also requires source monitoring and Telegram automation to be enabled. It checks source permission before generation, before committing the result, and when deciding retries. Turning Telegram automation off preserves originals, drafts, pending preparation jobs, and RSS processing.

Keep the existing server `DATABASE_URL`, `INGEST_WORKSPACE_ID`, and `INGEST_READER_SECRET`. The connected service keeps its existing `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `session.txt`, `CHANNELS_API_URL`, `INGEST_POSTS_URL`, `INGEST_READER_SECRET`, and existing output/intake exclusions. No credentials are sent to the browser or database. The publishing API URL is derived from the origin of `INGEST_POSTS_URL`: `/api/reader/publishing`. Existing HTTPS/localhost URL restrictions apply.

From `telegram-reader`, start the existing reader with `node reader.cjs`. This also starts the separate publisher module, using the same client. Reader monitoring remains responsive while publishing polls independently. Stop with Ctrl+C; the publisher stops scheduling work, waits at most 15 seconds for its current task, and the reader disconnects the client. Do not start a reader during implementation checks merely to test publishing.

Sign in with verified, approved automation access in the connected workspace. Open Publishing, enter `@news_output_test`, and Save and verify destination. The running reader resolves the channel to a stable marked ID and requires a broadcast channel that the account owns or can post in. Refresh to see verification or a useful permission/identity error. The destination cannot be a source, including a source resolving to the same stable ID. Enable publishing only when ready. Turn on Telegram automation for the intended source separately, and enable AI settings for new preparation if needed.

## Review and sending

Save edits first, then Approve. Save changes review to pending; Approve only records approval. **Publish** queues the exact saved, approved final text, draft revision, verified destination ID/username, and destination revision. Requests do not use unsaved textarea text. Telegram text is plain, with no formatting entities or link previews; a conservative limit of 4,096 UTF-16 code units includes emoji. Longer text is rejected with instructions to edit, save and approve it. It is never silently split or truncated.

Review status and publication status are separate. Queued, sending, delivery unknown, published and failed appear in AI Drafts; refresh to see updates. Text and review changes are blocked while delivery is queued, sending, uncertain, or already published. Published records contain confirmed chat/message IDs and Telegram's message time. View published message uses the stable `t.me/c/...` link when available; Telegram may require account access to open it.

Changing the destination or explicitly reverifying it advances its revision. Existing queued snapshots keep their old destination and fail eligibility once the new destination is verified; they never redirect. Publishing enable/disable by itself pauses/resumes eligible snapshots without changing their destination. To use a changed destination after a failure, Save the draft to create a new revision, then Approve and Publish again. Published drafts remain immutable.

Immediately before invoking Telegram, the reader resolves the pinned channel, checks its posting permission, and requests fresh server authorization. The server checks owner approval, verified email, workspace automation permission, source monitoring/automation, publishing enablement, verified destination/revision, and draft approval/revision. These are short database decisions; Telegram requests run outside transactions. **Disabling a setting or suspending access cannot recall a send already in flight**, including a request that passed authorization just before the change.

## Delivery and recovery

The server serializes decisions by locking workspace/access/settings/source rows, claims durably with a random token and a 120-second lease, and permits only one sending or uncertain publication per workspace. The module polls every five seconds, takes one job at a time, uses 10-second HTTP deadlines, 30-second destination/read deadlines and a 60-second send deadline. Paused sources retain queued work. An uncertain publication pauses further dispatch in that workspace.

The installed teleproto API supports raw `Api.messages.SendMessage` with a persisted signed 64-bit `randomId`. This is reused for safe retries of that publication, including definite rejections and explicit no-send recovery. The shared client uses `requestRetries: 1` and `floodSleepThreshold: 0` so application decisions control retries/waits. Transport reconnection may still occur using the same request identifier. See [Telegram's sendMessage method](https://core.telegram.org/method/messages.sendMessage) and [random ID deduplication](https://core.telegram.org/api/updates).

Successful receipts are written to `telegram-reader/publication-receipts/` with file sync and atomic rename before acknowledgement. This ignored runtime directory contains publication IDs/tokens and delivery IDs/times, not session credentials. Preserve it across reader restarts and deployments. Outcome-specific files ensure that acknowledging an older uncertainty report cannot delete a late success receipt. The module flushes receipts before claiming more jobs. If the website is unavailable or rejects an acknowledgement, it retains the receipt and retries recording only; it does **not** resend. Receipt reporting remains authenticated and workspace scoped even after access has been suspended, so a completed send can still be recorded.

Explicit Telegram RPC rejections become Failed. Known flood waits keep the same snapshot queued until the wait ends, and a durable workspace flood deadline blocks other sends too. Timeouts, network/server errors, missing receipts and crashes after a possible send become Delivery unknown. Expiring a sending lease never authorizes another send. A late successful receipt can settle an uncertain delivery. A crash after Telegram accepts a message but before the receipt reaches disk still requires recovery; there is no unconditional exactly-once guarantee.

For Delivery unknown:

1. Inspect the pinned destination in Telegram. If the exact post exists, enter its numeric message ID in AI Drafts and choose **Verify and record existing message**. The connected reader reads the message, checks channel identity, outgoing status and exact snapshot text, then records the confirmed receipt. It sends nothing. If the channel was renamed, it first resolves by stable ID and can recover the entity from up to 500 account dialogs. A mismatch leaves delivery uncertain with an error.
2. If there is no matching post, stop all instances of the reader, wait at least ten minutes from dispatch, and inspect Telegram again. Ensure pending durable receipts have been reconciled before asserting no delivery. Check the confirmation box and choose **Confirm nothing was sent**. This records the owner's recovery decision and marks Failed; it does not send anything or queue automatically. Restart the reader and deliberately Publish again if wanted. A retry of the same snapshot keeps its Telegram random ID.
3. Never delete unacknowledged successful receipt files to unblock sending. If a late successful receipt conflicts with a manual recovery decision or the database rejects it, stop publishing and reconcile the recorded Telegram message against the immutable snapshot. The module retains that receipt and pauses rather than treating it as a new send.

## Automated validation

Run from `web`:

```powershell
npx.cmd tsc --noEmit
npm.cmd run lint
npm.cmd run build
npm.cmd run check:publishing
npm.cmd run check:telegram
```

Run from `telegram-reader`:

```powershell
npm.cmd test
```

The PostgreSQL checks create a UUID-named disposable schema, apply all migrations there, use synthetic rows, and drop only that schema in `finally`. They require schema-creation permission. They do not process application jobs. The actual server actions, workspace guard, reader authentication and endpoints execute against that schema; only sessions and Next redirect/revalidation adapters are mocked. The reader unit tests mock every Telegram method and HTTP call and use temporary receipt directories. No real Telegram messages are sent.

Coverage includes workspace isolation, reader authentication, disabled/suspended/unverified access, default-off controls, source pause before preparation and draft commit, duplicate clicks, concurrent claims, immutable snapshots, blocked edits/review, destination changes and stable ID conflicts, overlong text, posting permission failures, definitive rejection, flood waits, uncertain lease expiry, explicit recovery, idempotent receipts after suspension, send success followed by acknowledgement failure/restart, and late success after timeout. The existing AI/RSS integration check also verifies the independent RSS worker and legacy editing behavior. Authenticated browser checks and the live Telegram test below remain manual.

Implementation validation passed: TypeScript, lint, production build, both PostgreSQL integration checks, and seven mocked reader tests. The build emitted only the existing warning about a lockfile outside this repository. No live reader was started for these checks and no real Telegram messages were sent.

## Manual live test — operator only

This procedure intentionally sends a real test message; it was **not run during implementation**.

1. Sign in as the connected approved owner. Confirm Zulfyh still owns `@news_output_test`, that it is absent from monitored sources, and that the intended test source is distinct. Start the website and existing reader. Configure and verify that destination with publishing initially off. Refresh and confirm its stable channel ID. An inaccessible or non-owned channel must show a permission error.
2. Enable source monitoring and Telegram automation for one test source, enable AI settings, and receive a harmless synthetic test original after AI activation. Run `npm.cmd run worker:telegram:once` from `web`. Confirm the collected original and independent RSS result are preserved.
3. In AI Drafts, Save harmless clearly labelled test text, then Approve. Confirm neither action posts anything in Telegram. Try 4,097 characters and confirm Publish refuses it, then Save and Approve shorter text. Enable publishing when ready.
4. Click Publish twice or in two tabs. Confirm exactly one queued publication exists, editing/review is locked, and exactly one plain-text message arrives in `@news_output_test`. Refresh; confirm Published with chat/message IDs and time, and open View published message. Compare its text to the saved snapshot, including Arabic, emoji and literal formatting marks.
5. For another approved test draft, turn off source Telegram automation or publishing before dispatch. Confirm it is not sent and that RSS/originals/drafts remain available. Changing the destination must never send the existing snapshot to the new channel. Restore settings only when deliberately testing another send.
6. To exercise acknowledgement failure under supervision, make the result endpoint temporarily unavailable after a test send. Confirm the reader retains a successful receipt and repeats only acknowledgement. Restore the endpoint and restart the reader; confirm Published with the original message ID and no additional Telegram message.
7. If any send becomes uncertain, inspect Telegram and use the explicit recovery flow above. To test existing-message recovery, select the exact sent test post; a wrong ID/text/channel must not be recorded. For no-send recovery, stop all reader instances and wait/inspect before confirmation. Do not repeatedly click Publish to resolve uncertainty.
8. Disable publishing and the test source's Telegram automation after testing. Confirm `/review` and RSS continue to work. Avoid deleting original/draft history merely to clean up a test.

No unrelated dependencies were upgraded and no changes were pushed to GitHub.
