# Campaign source/destination UI update

This update assumes Auto-send is already deployed and working. It adds no schema migration and does not change ingestion, AI processing, queue dispatch, receipts/recovery, workspace connection ownership, or RSS behavior. Earlier source changes from the Auto-send implementation remain in the working tree; they are not new migrations for this UI task.

Overview now contains source management and a single destination card. Desktop shows source cards on the left with thin blue or muted configured-participation connections to the destination on the right. The shared rail is muted; each branch reflects its source's confirmed participation switch. Cards include channel title/username, independent monitoring status, and text indicating active/paused/not joined. The list is bounded and scrolls with many sources; connectors stay in the gutter. Mobile stacks cards and destination with no connectors or horizontal scrolling. Search and oldest/newest ordering remain. Adding/managing sources stays available through Sources / RSS.

Destination verification and its errors remain visible. Change destination retains Save & verify, preserves publishing enablement, and never redirects existing snapshots. The technical ID and verification timestamp are in Details. Connections represent configuration, not live delivery.

Settings contains AI preparation and Telegram delivery. AI enablement, publishing enablement, Auto-send and campaign participation use accessible button switches with `role=switch`, `aria-checked`, visible On/Off or Active/Paused text, keyboard activation and pending feedback. Values change only on a server-confirmed response; a request lock prevents repeated submissions. Failed saves retain/restore confirmed state and show an error. Newer server revisions take precedence over older responses.

AI enablement sends only its flag and revision. It never submits unsaved model/editorial/prompt fields. The controlled text form has a separate Save AI settings button and preserves enablement from the locked database row. Both share the successful revision. Unsaved text remains through switch changes and failed saves; external revisions require reload before stale content can overwrite server settings. Destination-only saves similarly preserve publishing enablement; publishing-only saves preserve destination snapshots and the existing destination revision semantics.

Auto-send enabling still requires the destination-naming confirmation dialog and acknowledgement checkbox. Cancel/Escape does not send a request. Closing resets the acknowledgement. Turning off calls the existing Auto-send action with unchanged activation, queue-cancellation and recovery semantics. The authorized/in-flight-send limitation remains visible in confirmation and relevant action feedback.

Question-mark help buttons group explanations by topic. Hover/focus shows help; click/tap pins it. Escape/outside pointer press closes it. Portaled help is clamped to the viewport and moves with scrolling, including keyboard focus scrolling. Errors, unavailable reasons, unsaved changes, verification failures and required confirmation text remain visible.

## Changed files for this UI task

| Files | Purpose |
| --- | --- |
| Campaign Overview and Settings pages | Source/destination diagram and execution-control relocation. |
| `web/src/components/SettingSwitch.tsx` | Shared accessible switch and confirmed-state request handling. |
| `web/src/components/HelpButton.tsx` | Hover/focus and pinned help with viewport positioning and dismissal. |
| `AiSettingsEditor.tsx` | Independent AI switch, controlled text edits and shared revision handling. |
| `DirectPublishingControls.tsx` | Separate destination and publishing modes, immediate publishing switch and retained verification/recovery controls. |
| `AutoSendControl.tsx` | Switch with unchanged explicit destination acknowledgement and immediate OFF action. |
| `CampaignForms.tsx` | Participation switch, retained paused joining and confirmed response state. |
| `web/src/app/actions/ai.ts`, `direct-publishing.ts` | Reuse existing authorized transactions for enablement-only/content-only/destination-only requests. |
| `web/src/app/actions/campaigns.ts`, `auto-send.ts` | Return scoped confirmed switch state/revisions, including applicable failure feedback. |
| `web/src/app/globals.css` | Responsive diagram, restrained blue connections, switches and help styling. |
| Campaign UI integration/browser scripts | Persist/reload checks, unsaved AI edits, failed/stale/duplicate saves, cancellation, help and many-source/empty/Arabic layout fixtures. |
| This document and campaign UI overview | Current behavior, validation and website-only restart instructions. |

## Validation

From `web`, using Node 24 and installed dependencies:

```powershell
npm.cmd run check:campaign-execution:staged
npm.cmd run lint
node --import ./scripts/staged-campaign-client.mjs --import tsx scripts/check-campaign-ui.ts
npm.cmd run check:auto-send:build
$env:CAMPAIGN_UI_BUILD = Get-Content .campaign-ui-validation/build-path.txt
npm.cmd run check:campaign-ui:browser
Remove-Item Env:CAMPAIGN_UI_BUILD
Set-Location ../telegram-reader
node --test publisher.test.cjs
```

The staged check runs TypeScript against a separate client, migrations only in disposable schemas and mocked AI/Telegram boundaries. It verifies unchanged Auto-send generations, shared queue safety, unknown recovery, receipt replay and independent RSS. The build command creates an ignored isolated copy and preserves the main generated client/build used by running services. Browser fixtures cover 1440px/390px layouts, Arabic, many-source and empty diagrams, contrast, switch save failures/stale responses/duplicate clicks, Auto-send cancellation/acknowledgement, unsaved AI prompt edits and keyboard/click help. Database tests read freshly rendered Settings after ON/OFF to check persistence. They do not change settings or send messages in the live workspace.

## Exact website restart (not executed)

Validation completed on 2026-10-08: TypeScript, lint, isolated webpack production build, campaign UI/database integration, offline desktop/mobile browser checks (including hover and real emulated touch help), staged campaign/AI/publishing/Auto-send/RSS regressions and all nine mocked reader tests passed. `git diff --check` passed. The authenticated live-workspace review and restarts below were not performed.

Auto-send's migration and generated client are already deployed for this task; there is no migration or client-regeneration step. Leave the existing Telegram reader, AI worker and RSS worker running. Restarting those services is unnecessary for this UI update.

For a production website launched in a terminal:

1. In the terminal running the website, press Ctrl+C and wait for it to exit. If a process manager owns it, stop only its website entry through that manager.
2. In the website terminal, run:

```powershell
Set-Location -LiteralPath 'C:\Users\Jalal\Desktop\Work folder\news-automation\web'
npm.cmd run build -- --webpack
if ($LASTEXITCODE -ne 0) { throw 'Build failed; keep the website stopped and resolve the error.' }
npm.cmd run start -- --port 3000
```

Port 3000 is the existing local reader/API target. Keep the previously configured port if your installation uses another one. If managed as a service, start its existing website entry after the successful build instead of launching a second website instance. The isolated validation build is not the deployed website build.

For a development website, stop its existing terminal with Ctrl+C, then run `npm.cmd run dev -- --port 3000` from the same `web` directory. Refresh the browser afterward. No reader restart or destination reverification is needed unless the destination actually changes.

The implementation session does not execute these restarts, enable any live setting, migrate the main database, or push changes. Existing running publishers continue under their current deployed settings; the UI update does not itself enqueue or send anything.

## Short review

Open a campaign Overview at desktop and mobile widths. Search/order sources, check active and paused branch colors/text, expand destination Details and open Change destination. Settings should hold all execution switches. Change AI instructions without saving, toggle AI off/on, and verify the text and Unsaved AI settings message remain; then Save AI settings. Toggle publishing off/on and refresh to confirm state. Cancel Auto-send enabling before acknowledgement and verify it remains off; use mocked delivery for the confirmation/send test. Test help by hover, keyboard focus, click/tap, Escape and outside click. Use disposable fixtures for these checks rather than toggling live delivery settings.
