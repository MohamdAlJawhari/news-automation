# Approved campaign UI

The focused source/destination diagram, Settings execution switches and compact help update is documented in [CAMPAIGN_UI_FLOW.md](CAMPAIGN_UI_FLOW.md). It supersedes the Overview execution-control layout and checkbox/save-button descriptions below. Auto-send is already deployed; this UI update needs only a website build/restart, with no migration or worker/reader restart.

Campaign Auto-send is now implemented; see [AUTO_SEND.md](AUTO_SEND.md) for confirmation, future-only boundaries, automatic approval versus delivery, validation and deployment. Its instructions supersede the automatic-publishing deferral and no-migration UI-only rollout below. The approved white theme is preserved.

This release implements the white/blue sidebar design on the existing campaign-aware backend. The earlier five-tab UI instructions in this document are **superseded** by the routes and workflow below. Backend transition, deployment gates, receipts and recovery procedures remain documented in [MULTI_CAMPAIGN_EXECUTION.md](MULTI_CAMPAIGN_EXECUTION.md); descriptions there of Default-only UI routes are superseded here.

## Interface and routes

Global navigation contains Campaigns, Sources / RSS and owner-authorized Users. A selected campaign's name appears above Overview, Drafts and Settings in the sidebar. Navigation wraps on mobile. White surfaces, dark headings, medium-gray secondary text, blue selected backgrounds and a shared outline SVG icon family are fixed across themes. Icon-only controls have accessible names and native tooltips; dialog focus is trapped by native modal dialogs and restored to the launcher on close. Arabic content uses automatic direction and wrapping; English/Arabic content can coexist.

Campaigns supports database-backed name search, newest/oldest sorting and grid/list display. Campaigns, Overview sources and Drafts now share immediate search (400 ms debounce or Enter), an icon sort-order toggle and named icon display buttons; there is no Apply button or sort/display dropdown. Overview uses the same grid/list card spacing as Campaigns. Unsaved edits must be confirmed before automatic filtering or sort/display changes. Creation is in a dialog. Card names open campaigns; overflow contains Rename and empty-campaign deletion. New campaigns retain disabled settings and no memberships. Rename retains its saved timestamp to reject stale edits.

Overview combines campaign source participation, destination status and manual publishing controls. Checked memberships participate; workspace monitoring is displayed separately and remains managed through Sources / RSS. Joining still starts paused and establishes a future-only boundary. Unchecking pauses without removing memberships or backlog; checking resumes retained eligible work. Independent RSS behavior is unchanged.

Change destination opens an editor with **Save & verify**. Verification checks posting permission and sends no message. Manual publishing enablement is saved separately from destination editing and AI preparation. Destination revisions, stable Telegram identity checks, immutable queued snapshots and in-flight send limitations remain unchanged. AI model, enablement, editorial instructions and expandable advanced prompt are grouped in Settings, with the existing first-activation and saved revision rules.

Drafts contains one **Final text · AI prepared** editor. Original AI output is still stored in `AiDraft.aiText`, exposed in an expandable section and never updated by manual saves. Compare places original post beside final text; Cards uses compact cards with expandable originals. Search covers final text, AI output, original post and source username in the selected workspace/campaign before pagination. Sorting has an ID tie-breaker; pagination retains search, sorting and display parameters. Unsaved edits guard navigation, refresh, filter submission and dialog dismissal. Revision checks and explicit Save → Approve → Publish remain. Draft action styling follows the provided reference: an outlined reject X on the left, outlined Save draft and a light-blue Approve button with an outline send icon on the right. Approve continues to record review only; Publish remains separate, so the button is labeled Approve rather than implying an immediate send. Published drafts have read-only final content and confirmed message links. Errors and delivery-unknown recovery remain next to each publication.

| Compatibility URL | Redirect |
| --- | --- |
| `/workspace/ai-drafts` | Default campaign `/drafts` |
| `/workspace/ai-settings` | Default campaign `/settings` |
| `/workspace/publishing` | Default campaign Overview |
| Campaign `/ai-drafts` | Same campaign `/drafts` |
| Campaign `/ai-settings` | Same campaign `/settings` |
| Campaign `/sources`, `/publishing` | Same campaign Overview |

Campaign redirects verify workspace ownership first. Default-only legacy actions remain Default-only. `/review`, legacy SQLite/n8n controls and independent RSS routes remain available. Campaign automatic publishing, archive lifecycle and multi-user Telegram connections are deferred; no inactive automatic publishing switch is displayed.

## UI/UX review refinements

A quick desktop/mobile review identified excessive mobile navigation height and unnecessary space/advice on published drafts. Mobile campaign links now fit a single row at 390px with 44px touch targets and tighter header spacing. Published final text uses a compact, subtly shaded read-only field; unrelated publishing-unavailable advice is omitted after publication, while confirmed links and recovery/history remain visible. Search includes a polite Updating status during navigation. Editing, authorization, revisions and publication actions are unchanged.

## Empty-campaign deletion

Deletion requires a confirmation checkbox and an automation-authorized workspace owner session. The server rechecks current account/workspace eligibility while holding owner and workspace locks in the established ingestion/worker lock order, then locks the campaign row `FOR UPDATE`. Default is rejected. Any processing job (including failed/completed), AI draft, publication or source membership rejects deletion. Memberships count as participation history even if paused; they are never removed to make a campaign appear empty.

Only AI/publishing configuration rows and the empty campaign are explicitly removed in the same transaction. No history cascade exists. Workspace locks serialize ingestion and membership changes with the check/delete; the campaign row lock and existing restrictive foreign keys also prevent concurrent direct FK inserts from silently racing the deletion. Failure rolls the entire operation back. No schema change or migration is needed. If future campaign-linked history tables are added, extend eligibility checks; keep their foreign keys restrictive.

## Changed files

| Files | Purpose |
| --- | --- |
| `web/src/app/workspace/campaigns/page.tsx` | Search/sort/display, compact cards, dialogs and overflow actions. |
| `web/src/app/workspace/campaigns/[campaignId]/page.tsx` | Combined sources, destination and publishing Overview. |
| Campaign `drafts/page.tsx`, `settings/page.tsx` | Canonical scoped Drafts/Settings pages, query controls and comparison/card layouts. |
| Campaign `sources`, `publishing`, `ai-drafts`, `ai-settings` pages; workspace compatibility pages | Ownership-checked redirects to the three-page layout. |
| `web/src/app/actions/campaigns.ts` | Existing create/rename/participation guards plus transactional empty deletion. |
| `web/src/components/CampaignToolbar.tsx`, `CampaignForms.tsx`, `CampaignDialog.tsx`, `OutlineIcon.tsx` | Shared immediate search/sort/display, named controls, native dialogs, participation checkbox and confirmation. |
| `CampaignUI.tsx`, `AppNavigation.tsx`, `WorkspaceUI.tsx` | One responsive sidebar with permission-aware navigation. |
| `AiDraftEditor.tsx`, `AiSettingsEditor.tsx`, `DirectPublishingControls.tsx`, `useUnsavedChanges.ts` | Preserved revision flow, read-only published content, grouped settings, separate destination/control forms and unsaved GET guard. |
| `web/src/lib/campaign-drafts.ts` | Scoped database search/sorting before pagination. |
| `web/src/app/globals.css`, `layout.tsx` | White theme, contrast, responsive layouts and system fonts supporting Arabic/English; removes unused remote font downloads so builds work offline. |
| `web/scripts/check-campaign-ui.ts`, `check-campaign-ui-browser.mjs` | Disposable database and offline browser regression coverage. |
| `CAMPAIGN_UI.md`, `README.md`, `web/README.md`, `MULTI_CAMPAIGN_EXECUTION.md` | Current handoff and superseded UI instructions. |

The checkout already contained the earlier campaign implementation, including scoped AI/publishing actions, campaign-page helper, RefreshButton/access/source changes and package scripts. Those protections were retained. No dependency or migration changes were introduced by this design update.

## Validation

Use Node 24 on PATH and installed locked dependencies. From `web`:

```powershell
npx.cmd tsc --noEmit
npm.cmd run lint
npm.cmd run build
npm.cmd run check:campaign-ui
npm.cmd run check:campaign-ui:browser
npm.cmd run check:campaign-execution:staged
```

From `telegram-reader`: `node --test publisher.test.cjs`.

The UI/database suite creates and drops randomly named disposable PostgreSQL schemas, applies migrations only there and mocks authentication, AI and reader boundaries. It validates two campaigns, ownership/access denial, stale revisions, shared sources, independent participation, immutable publication snapshots, original AI preservation, old redirects, search beyond the first page, Default/confirmation/history deletion guards and deletion competing with ingestion and membership creation.

Browser checks use actual server-rendered fixtures and production CSS at 1440px and 390px, plus real interactive React editors with mocked actions. They check horizontal overflow, white theme, heading/body secondary contrast against white (at least 4.5:1), icon names/tooltips, Arabic direction, saved revisions, separate Save/Approve/Publish, dialog Escape/focus restoration and unsaved navigation/refresh/filter protection. External requests are blocked. Fixtures/screenshots live under ignored `web/.campaign-ui-validation/`. Set `CAMPAIGN_UI_CHROME` to a compatible installed Chromium executable if the default Playwright headless shell is unavailable.

The broader staged suite verifies populated history, receipt replay, late receipts, publishing isolation, independent RSS and preparation eligibility. Reader tests mock Telegram/HTTP. No test sends a live message or migrates the main schema. Synthetic fixtures do not certify a deployed authenticated login session.

Validation completed on 2026-10-07: TypeScript, lint, production build, campaign UI/deletion integration, offline browser checks (including comparison/list layouts, dialog focus and participation checkbox intent/revision), staged campaign execution/AI/publishing/RSS checks and all 9 mocked reader tests passed. The authenticated manual test below is documented for an isolated deployment and was not run against a live login/session. No main schema migration, dependency change, live Telegram message or push was performed.

## Restart and short authenticated manual check

This UI assumes the campaign execution/settings backend is already deployed. **No main migration, catch-up or settings copy is part of this task.** Existing deployment gates in the backend document remain applicable. To deploy the reviewed UI, build in `web` with `npm.cmd run build`, replace the website process through its existing process manager and start with `npm.cmd run start`. No reader/worker protocol or restart is required for this UI. Keep the existing reader session and receipt journal intact; starting a connected reader can dispatch queued manual publications.

In an isolated authenticated test deployment with mocked AI/Telegram and disposable data:

1. Sign in as an approved automation-enabled test user. At desktop and mobile widths, create Arabic and English campaigns from the dialog, search/sort, switch grid/list, rename through overflow, and navigate Overview/Drafts/Settings using mouse and keyboard. Check focus after Escape and medium-gray readability. RSS-only users retain Sources / RSS and cannot open campaigns; Users is owner-only.
2. Join a source to both campaigns; it starts paused. Check participation in one, then pause/resume and confirm monitoring and the other campaign remain independent. Change destination, Save & verify and inspect verified/error/pending status with a mocked reader; no send should occur. Save manual publishing separately from AI settings.
3. With more than 20 mocked drafts, search for Arabic text on a later page and sort oldest/newest. Compare and Cards must show the same scoped drafts. Edit final text; cancel navigation/filter/refresh. Save, Approve and Publish separately through the mock; original AI output must stay unchanged. Check a published fixture's read-only content/link and a delivery-unknown fixture's recovery form. Submit stale revisions and foreign workspace IDs; both must be rejected.
4. Delete a new empty non-Default campaign after confirmation. Default, joined campaigns and campaigns with jobs/drafts/publications must fail. Run ingestion while attempting deletion and confirm the job/history survives or ingestion finds the deleted campaign unavailable; no orphan work is permitted. Try old URLs and confirm their canonical redirects. Retain legacy review and RSS behavior.

Do not send a live Telegram message or create manual-test data in the main workspace for this verification.
