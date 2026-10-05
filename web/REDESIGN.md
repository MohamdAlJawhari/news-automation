# News automation UI and entry flow

## AI preparation stage added October 5, 2026

The light workspace navigation now includes **AI Drafts** (`/workspace/ai-drafts`) and **AI settings** (`/workspace/ai-settings`) for verified, approved accounts with automation permission. These PostgreSQL routes are separate from the owner-only SQLite/n8n `/review` workflow. AI approval records a review decision without publishing. The additive schema, standalone Telegram preparation worker, setup commands, validation boundaries and manual checks are documented in [AI_PREPARATION.md](AI_PREPARATION.md). Earlier statements below about no added AI pipeline/schema changes describe the preceding redesign, before this stage.

The application uses the supplied light gray-blue background, white cards, subtle borders/shadows, blue actions, compact navigation, and responsive Arabic/English text rendering. The channel dashboard is the main destination for eligible accounts. No statistics cards, decorative count badges, media controls, API links, or replacement AI pipeline were added.

## Final route map

| Route                                                                | Behavior / access                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                                                                  | Fresh session and database-backed user/workspace check. Signed out -> `/login`. Verified, approved account with a workspace and RSS or automation enabled -> `/workspace/sources`. Other signed-in accounts -> `/account-status`.                                                             |
| `/workspace`                                                         | Uses exactly the same entry decision as `/`.                                                                                                                                                                                                                                                  |
| `/login`                                                             | Light Google sign-in form. Signed-in visitors use the entry decision; Google callback stays `/` so the server decides from fresh access data.                                                                                                                                                 |
| `/account-status`                                                    | Signed-in status page for unverified email, pending/rejected/suspended approval, missing workspace, or no enabled services. Eligible accounts redirect to Channels; signed-out visitors redirect to login. Check status returns through `/`.                                                  |
| `/workspace/sources`                                                 | Main channel dashboard for verified, approved workspace users with at least one enabled service. PostgreSQL channel add/search, latest original excerpts, monitoring, and distinct RSS availability/link controls.                                                                            |
| `/workspace/rss?source=<id>`                                         | Contextual channel settings; RSS permission and workspace-scoped source lookup required. One save for metadata, enabled state, header/footer, removal chips, and ordered replacement rules. Separate link creation/replacement/revocation. Without a selected channel, redirects to Channels. |
| `/workspace/rss/items?source=<id>&view=<original-or-processed>&page=<n>` | Contextual, paginated original-post viewer with source-management access. Processed preview and manual RSS editing/hide/restore require RSS permission. Without a selected channel, redirects to Channels.                                                                                    |
| `/review`                                                            | Former root News Review workflow. Verified, approved owners only, independently of workspace/service availability. Existing SQLite drafts, editing/approval/rejection, publishing, publication recovery, and auto-publish controls are preserved.                                             |
| `/users`                                                             | Verified, approved owner administration, with existing server-side access checks and validations.                                                                                                                                                                                             |
| `/channels`                                                          | Verified, approved owners only. Separate legacy SQLite source workflow, accessible from `/review` as **Legacy source channels**; never merged with PostgreSQL source channels.                                                                                                                |
| `/rss/[token]`                                                       | Existing RSS XML endpoint and token checks, unchanged.                                                                                                                                                                                                                                        |
| `/api/*`                                                             | Existing authentication, reader/ingestion secrets, workspace checks, and publishing behavior retained. Legacy draft API now invalidates `/review` after processing.                                                                                                                           |

The compact shared top bar contains Channels, account identity, and Sign out. Only verified, approved owners see News Review and Users. Contextual settings and posts stay attached to their selected channel. Hiding links never replaces page/action/API authorization.

`getCurrentAccess` still reads current user approval, email verification, role, workspace, and service flags from PostgreSQL, rather than trusting session role/status fields. `getEntryDestination` centralizes entry decisions. Workspace checks reject missing/disabled workspaces to account status and unavailable individual features to the eligible channel dashboard. Owner guards send unauthorized users to their entry destination. These transitions avoid redirecting a restricted account repeatedly between root and workspace.

## Changed files

Entry/navigation continuation:

- `src/lib/access.ts`: shared entry decision and access type, retaining the fresh database query.
- `src/lib/workspace-access.ts`, `src/lib/admin.ts`: consistent redirect destinations; approved-owner access helper retained alongside the existing session-returning admin guard.
- `src/lib/account-status.ts`, `src/app/account-status/page.tsx`: account status reasons and presentation.
- `src/app/page.tsx`, `src/app/workspace/page.tsx`: entry redirects.
- `src/app/login/page.tsx`, `src/components/LoginForm.tsx`: server-side signed-in routing and light client sign-in form.
- `src/components/AppNavigation.tsx`, `src/components/WorkspaceUI.tsx`, `src/components/SignOutButton.tsx`, `src/app/globals.css`: shared compact navigation, identity, responsive spacing, and light presentation.
- `src/app/review/page.tsx`, `src/components/RefreshButton.tsx`: moved and restyled review UI, Legacy source channels navigation, and explicit router refresh for Refresh drafts.
- `src/components/DraftEditor.tsx`, `src/components/AutoPublishSwitch.tsx`, `src/components/PublishButton.tsx`, `src/components/PublicationRecovery.tsx`: matching light review controls; existing action and field semantics retained.
- `src/app/users/page.tsx`, `src/app/channels/page.tsx`: matching cards/forms/feedback and pending submit buttons.
- `src/app/workspace/sources/page.tsx`, `src/app/workspace/rss/page.tsx`, `src/app/workspace/rss/items/page.tsx`: shared top bar with fresh account identity.
- `src/app/actions/drafts.ts`, `src/app/actions/publish.ts`, `src/app/actions/recover-publication.ts`, `src/app/actions/settings.ts`: invalidate `/review` after save/approval/rejection/publication/recovery/auto-publish setting changes.
- `src/app/api/drafts/route.ts`: invalidate `/review` after legacy draft ingestion/automatic publication. The shared `publish-draft.ts` helper was inspected and has no route-specific refresh paths; its publishing behavior is unchanged.
- `src/app/actions/users.ts`: invalidate users, account status, and Channels after account/service access changes.
- `REDESIGN.md`: final route map, changed files, validation, and manual checks.

Earlier channel redesign retained: `src/components/RssSettings.tsx`, `src/components/RssRulesEditor.tsx`, `src/components/RssItemEditor.tsx`, `src/components/SubmitButton.tsx`, `src/app/actions/rss.ts`, and the contextual channel routes listed above. `src/app/layout.tsx` retains the application metadata.

## Preserved RSS and backend behavior

Settings validate all fields and save metadata, enabled state, header/footer, and both rule lists together. Structured replacement fields preserve literal `=>` text. Existing whole-word, case-sensitive matching and Remove -> Replace -> Header -> Footer execution continue through `processRssContent`.

Original shows `OriginalPost.originalText`. Processed previews start from saved `RssItem.content`, including manual edits, and apply current saved rules. Missing RSS items, empty processed content, processing errors, and hidden-item eligibility have explicit states. RSS titles are automatically generated; stored item titles are not presented as controlling feed titles. Manual content editing and optimistic-concurrency hide/restore behavior remain available.

RSS raw links exist only in the generating action's client state. Existing `tokenHash` values are never converted back to tokens or stored in localStorage. Copy is available only while the raw link is available and never rotates a link. Clipboard failure offers manual selection. Replacement and revocation are explicit, separate actions.

No schema, dependency versions, reader ingestion rules, RSS worker processing, XML generation, shared publishing helper behavior, or saved data were changed. No environment file contents or secrets were inspected. Test fixture data was isolated from the real application and removed after checks.

## Validation results

The repeated entry-flow request was audited against the current files; TypeScript, lint, and production build were rerun successfully. The current root contains only the shared entry redirect, and all review mutation refresh paths target `/review`. If an older root UI is still visible, restart the application from this `web` directory with the newly built output.

- TypeScript: `tsc --noEmit` passed.
- Lint: `eslint .` (the existing `npm run lint` script) passed.
- Production: `next build` (the existing `npm run build` script) passed. Next emits an existing warning about a lockfile outside this repository; configuration/dependency versions were not changed.
- Real production browser, signed out: at 1440px and 390px, `/`, `/workspace`, `/account-status`, `/review`, `/users`, `/channels`, and `/workspace/sources` resolve to `/login` with no horizontal overflow. The real login layout was inspected.
- Actual server modules with mocked session/database I/O: entry, login, status, workspace/source, and owner guards tested for signed out, unverified, pending, rejected, suspended, missing workspace, no services, approved regular RSS user, approved regular automation user, approved owner, approved owner without services, and suspended owner. Fresh database values override stale owner/approval claims in session fixtures. Direct access to review, users, and legacy channels is rejected for non-owners/restricted users. Unavailable RSS permission on an automation-only account returns to Channels.
- Actual review actions with mocked database/publishing I/O: save, approve, reject, publish, recovery, and auto-publish setting changes refresh `/review`; regular-user requests are rejected before writes/sends. Legacy draft API secret authorization and `/review` invalidation were checked. These tests made no real database writes or Telegram requests.
- Actual UI components with isolated fixture data: desktop/mobile review, Users, legacy channels, account status, login, and regular-user dashboard layouts inspected at 1440px and 390px with no horizontal overflow; Arabic/English text and long account identities included. Owner/regular navigation visibility, login callback/error feedback, review editor unsaved/save feedback, auto-publish switch, publication recovery controls, legacy link, and sign-out destination checked. These are fixture checks, not authenticated end-to-end verification.
- Earlier isolated channel checks passed for ordered rule chips, combined settings feedback, literal Find text, safe link copying/revocation, Original/Processed behavior, missing/empty/hidden RSS states, and manual editor access.

There is no authenticated session available for real account-status/owner/workspace checks. Real Google OAuth, authenticated PostgreSQL account/service changes, SQLite review updates, Telegram publication/recovery, and RSS delivery still require manual verification. Fixture tests do not prove live writes, login, delivery, or worker execution.

## Remaining manual checks

1. Sign in through real Google OAuth with pending, suspended, approved regular, and approved owner accounts. Verify root/workspace/login destinations and Check status after access changes. Include unverified email, rejected account, missing workspace, and no enabled services.
2. Attempt direct `/review`, `/users`, `/channels` access as a regular/suspended account. Confirm owner pages remain available to approved owners independently of their workspace service access.
3. On `/review`, save/approve/reject real drafts, change auto-publish settings, and verify the review screen refreshes. Test publication and recovery only with an intentionally selected test draft and destination. Confirm incoming legacy draft API updates appear after refresh and the legacy channel workflow remains independent.
4. Add/search/pause/resume real PostgreSQL source channels; check RSS feature permissions and foreign-workspace source/item IDs. Review contextual settings/post navigation on desktop/mobile.
5. Save/reload ordered RSS settings, compare saved-content previews with real feed output, and verify manual editing/hide/restore plus stale-save rejection. Test pagination with more than 20 posts.
6. Create/replace/copy/revoke a real RSS link and verify feed availability, old-link invalidation, and Manage link after reload without token recovery. Confirm clipboard failure offers manual copying.
