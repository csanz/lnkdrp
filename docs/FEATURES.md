# Features

**Maintenance:** Update this file whenever you change user-facing behavior (pages/routes, uploads, sharing/passwords/downloads, AI/reviews/metrics, projects, invites/auth, admin tools).

This document is a **product-oriented** breakdown of the main user-facing features currently implemented in this repo.

## Core concepts

- **Organization (Org)**: The top-level tenancy boundary. Every user has a 1:1 **Personal org** and can create additional orgs. Most records (projects/docs/uploads) are scoped to an org, and the UI uses an **active org** context.
- **Doc**: A PDF-backed document record with a title, processing status, extracted text, preview image, AI output, and a public `shareId` (alphanumeric only; so share URLs don’t expose Mongo `_id`). Docs also store per-page **slide nodes** (thumbnail/image URLs + hashes) for vision-assisted AI and visual diffs.
- **Upload**: An upload record representing an incoming file (or imported URL) and its processing pipeline (store in Blob, extract text, generate preview, extract per-page slide nodes, run AI). Slide nodes are stored per upload version so history can compare visuals across replacements.
- **Share link**: A public, recipient-facing page at `/s/:shareId` (legacy: `/share/:shareId`) that can optionally be password-protected and optionally allow PDF download.
- **Project**: A container that groups docs; docs can belong to multiple projects (`projectIds`) with a backward-compatible “primary” `projectId`.
- **Invite gating**: The unauthenticated experience is gated behind an invite cookie (invite code verification + request flow).

## Public pages (logged-out)

- **Home page**: `/` — Marketing/invite landing page with paperplane animation, invite code entry, login flow, and a small bottom-left copyright notice (`© YEAR LinkDrop`).
- **About page**: `/about` — Static page explaining what LinkDrop is and how it works.
- **Terms of Service**: `/tos` — Terms of Service page accessible from the logged-out homepage header.
- **Privacy Policy**: `/privacy` — Privacy Policy page accessible from the logged-out homepage header.

## Authentication & invite gating

- **Invite required to proceed** (pre-auth):
  - Enter an invite code (normalized) and verify it via `/api/invites/verify`.
  - Check current invite status via `/api/invites/status`.
  - Request an invite via `/api/invites/request` (email + description). The server avoids creating duplicate requests for the same email, and will nudge existing users to log in instead.
  - Auto-claim invite codes from email links via `/?invite=CODE` (client flow).
- **Login**:
  - Google sign-in via NextAuth (`/api/auth/[...nextauth]`) when auth is enabled.
- **“Temp user” support**:
  - Client requests can be decorated with temp-user headers (used for upload flows and other gated actions).
  - Server route `/api/auth/claim-temp` exists to claim/convert temp access.

## Preferences

- **Preferences page**: `/preferences`
  - A settings hub for account/workspace/usage/spending/billing (some areas are still a shell UI).
  - Supports deep links via `/preferences?tab=billing` (and pretty URLs like `/preferences/billing`).
  - Workspace tab includes **Notification preferences**:
    - Doc update emails (off / daily digest / immediately), stored per workspace member.
    - Repo link request emails (off / daily digest / immediately), stored per workspace member.
  - Note: these settings are also surfaced in **Dashboard → Account**.

## Dashboard (account + workspace hub)

- **Dashboard page**: `/dashboard`
  - Cursor-like standalone settings/analytics hub with a left mini-nav.
  - On mobile, the mini-nav is accessed via a **hamburger menu** in the dashboard header (opens a slide-in menu).
  - Left mini-nav shows the signed-in user name/email and a compact section list (Overview/Account/etc). The active workspace pill is shown in the top-left header.
  - Includes an **Overview** tab (default) that shows high-level workspace stats (e.g. new docs, pages viewed, share views) plus a **30-day activity graph** aggregated across all docs in the active workspace.
  - Overview includes a **Plan** card at the top:
    - Renders a **single** plan status card (no Free-vs-Pro comparison cards).
    - Uses `GET /api/billing/status` to show user billing state (plan + Stripe status + renewal date when available).
    - Uses `GET /api/credits/snapshot` to determine whether AI tools are currently blocked due to credits.
    - Free plan shows a calm status line and a **single** **Upgrade** CTA (Stripe Checkout via `POST /api/stripe/checkout`), plus a **View plan details** action.
    - After Checkout, the user lands on `/billing/success` which shows **“Processing…”** and polls `/api/billing/status` until **Stripe webhooks** update MongoDB (access is webhook-driven; we do not trust the redirect).
    - Pro plan includes a **Manage Subscription** button that opens a Stripe **billing portal** session (`POST /api/stripe/portal`) and a Billing shortcut.
    - When on Pro, the card also shows a small **On-demand usage this cycle** module with a **hard spend limit** editor (Cursor-style presets + custom).
  - Dashboard header (top-right) shows a **Credits: X** indicator (Dashboard-only) that links to the **Usage** tab (`/dashboard?tab=usage`) for the full breakdown. When the workspace is set to an unlimited on-demand cap, it shows **Credits: Unlimited**.
  - When the on-demand cap is set to **Unlimited**, the dashboard surfaces **Unlimited** (not a large sentinel number) anywhere an on-demand credit limit/headroom is displayed (header, Usage summary, Limits cards, Billing & Invoices on-demand section).
  - When credits are exhausted (and on-demand is disabled / has no headroom), the dashboard shows a persistent banner:
    - “AI tools are currently unavailable. You’ve used all credits for this billing cycle.”
    - The banner can be **dismissed** (per workspace + billing cycle). After dismissal, the banner stays hidden for the rest of the cycle and the **Limits** nav item shows a subtle doesn’t-miss indicator (tooltip: “Credits exhausted. Enable on-demand to continue.”).
  - Includes a **Contact Us** item in the left menu that opens a modal with the support email (`hi@lnkdrp.com`).
  - Account tab includes an **Edit name** modal (updates the signed-in user's display name).
  - Account tab includes **Email preferences** for the currently selected workspace (doc update + repo link request cadence).
  - User avatar UI uses **initials** (we do not display the Google profile image).
  - Workspaces can have an optional **workspace icon** (org avatar); recommended requirements: **square (1:1), at least 120×120**, and ≤ 2MB.
  - Includes a **Billing & Invoices** tab (`/dashboard?tab=billing` or `/dashboard/billing`) with:
    - **Included Usage** for the current billing cycle (credits-first; cost shown as Included).
    - **On-Demand Usage** for the current billing cycle (shows dollars used vs limit and line items).
    - **Invoices** list with month filter and a **View** link (Stripe hosted invoice URL when available).
    - **Manage subscription** button that opens the Stripe billing portal (`POST /api/stripe/portal`).

## Organizations & org switching

- **Org list + create**:
  - API: `/api/orgs` (list + create a new team org).
  - The client **preloads and caches** the org list on page load (best-effort `localStorage`) so the workspace switcher opens instantly.
- **Active org**:
  - The app tracks an “active org” in the signed-in session (JWT claim) and uses it to scope core data APIs (projects/docs/requests).
  - Workspace switching/management is available in **Preferences** (`/preferences`).
  - The active workspace indicator is shown in the UI near the top-left brand/logo area (best-effort, client-side indicator). If the workspace has an icon (org avatar), it’s shown next to the workspace name. If the user is on the Pro plan, the indicator also shows a small “PRO” plan badge.
  - The account menu workspace quick switch list also shows the workspace icon when available.
- **Switching mechanism**:
  - Org switching is performed via a server redirect route (`/org/switch`) which validates membership, sets an httpOnly active-org cookie, shows a brief “Switching workspace…” transition, and then redirects back to the current page (`returnTo`) so the app rehydrates in the new org context.
  - Exception: if `returnTo` is a doc route (`/doc/:docId*`) and the doc does not belong to the target org, the switch falls back to `/`.
- **Leaving an org**:
  - Members/admins can leave a team org via `/api/orgs/:orgId/leave` (owners cannot leave).
  - If you leave your currently active org, the app switches you back to your personal org.
- **Org invites**:
  - Org admins/owners can generate invite links for another user to join.
  - Org admins/owners can also **email an invite** to a recipient via `/api/org-invites/email` (which also creates an invite link token).
  - Bootstrap endpoint: `/api/org-invites/bootstrap` sets the invite-gating cookie so the recipient can proceed through Google sign-in.
  - Invite UI shows recent invite links with **Used / Not used / Expired** filtering, and includes a members tab for owners/admins.
  - For email-sent invites, the invite list displays the **recipient email**.
  - For used invites, the invite list also displays **who redeemed it** (best-effort name/email).
  - Org admins/owners can revoke (invalidate) an unused invite via `/api/org-invites/revoke`.
  - Org owners/admins can remove members from an org (API: `/api/orgs/:orgId/members/:userId/revoke`).
  - Recipients join via `/org/join/:token`, which signs in (if needed), claims the invite, and switches workspace (and shows an explicit error message if the claim fails).

## Document creation & uploads

- **Upload a local PDF**:
  - On the new-doc upload screen (`/upload`), selecting a PDF immediately shows an in-browser preview; the user then clicks **Upload** to begin the background Blob client-upload + processing pipeline.
  - Implementation: create a doc record, create an upload record, then start a Blob client-upload + processing pipeline.
  - Processing extracts per-page **slide thumbnails/images** into Blob and stores their URLs/hashes in the Upload + Doc records for downstream AI + history.
- **Upload via URL (import a PDF link)**:
  - Create doc + upload, ask the server to fetch the PDF into the upload (`/api/uploads/:uploadId/import-url`), then trigger processing (`/api/uploads/:uploadId/process`).
  - After processing, the doc title may be **auto-renamed** using the AI-derived document name (so URL uploads don’t end up named like `view`/`uc`).
- **Client upload test page**:
  - `/test/client-upload` (and redirect from `/client-upload`) exercises the Vercel Blob “client uploads” flow via `/api/blob/upload`.

## Doc view (owner)

- **Doc page**: `/doc/:docId`
  - Shows doc status (`draft`/`preparing`/`ready`/`failed`) and updates as processing completes.
  - Shows a fast **preview image first** (when available) and loads the full PDF viewer on intent (click **Open PDF**) to reduce initial load time on large decks. Preview always **fits fully** (no crop) and is **top-aligned**. The preview uses a consistent dark “stage” (even in light theme) and, for landscape previews, applies a subtle bottom blend that starts within the image and fades into black; portrait previews skip the blend.
  - PDF viewing via `PdfJsViewer` once the PDF is ready (owner uses a same-origin cached PDF proxy at `/api/docs/:docId/pdf`).
  - Header shows a small line with the **last upload/replacement** timestamp and **who uploaded it** (best-effort name/email), so owners can see who replaced a doc most recently.
- **Doc metrics page**: `/doc/:docId/metrics`
  - Loads charts/totals quickly from `/api/docs/:docId/shareviews`.
  - Viewers list loads shortly after (background) and avoids a Mongo `$lookup` by using denormalized viewer snapshots stored on `ShareView`.
  - Shows both **authenticated viewers** and **anonymous viewers** (best-effort, per browser/device), including per-viewer **pages viewed** (unique pages seen).
  - Clicking a viewer opens a **Viewer details** modal that shows the specific **pages seen** (page numbers) with best-effort **time per page**, best-effort **time spent** + **avg per view**, and first/last seen timestamps.
  - Viewer details also include a **Visits** view (best-effort per-tab sessions) which enables per-visit **time per page**, **revisited pages**, and a best-effort **page sequence** (path analysis).
- **Doc replacement change history**:
  - When the owner replaces a doc file (creating a new upload version), the server stores a best-effort “what changed” record (previous text, new text, summary + changes list).
  - Change hints can include best-effort **visual/graphics changes** using per-page slide node hashes, and may include previous/new slide thumbnail URLs for changed pages.
  - Changes are only accessible to users who have access to the doc (API: `/api/docs/:docId/changes`).
  - History UI: `/doc/:docId/history` (version badge links here).
  - History includes who uploaded each version (best-effort from user record).
  - If older versions are missing stored text snapshots, History still backfills a lightweight “replacement event” row so versions show up (diff summary may be unavailable).
  - Performance: History renders a compact, expandable list; it fetches previous/new extracted text **on-demand** only when a version is expanded.
  - History list supports simple **impact filtering**, **newest/oldest sorting**, and **cursor paging** (Load more).
  - History includes a best-effort **Recipients** preview for each version (workspace members + whether they opened that version), plus per-viewer **page timing** aggregates (internal-only; uses doc page timing events).
  - History UI includes a right-side overview panel with aggregate stats (replacements count, top editors, cadence, and best-effort impact/signals).
- **Starred docs**:
  - Starred state is **persisted in MongoDB** (source of truth) per user + workspace.
  - The UI uses a **localStorage cache** for fast UX and dispatches change events for cross-tab updates.
  - API: `/api/starred` (list/toggle/reorder). One-time migration helper: `/api/starred/bootstrap`.
- **Assign docs to projects**:
  - UI for viewing/adjusting project membership (multi-project aware).

## Sharing (owner controls)

- **Generate/copy share link**:
  - Share links are based on `shareId` (alphanumeric only) and resolve to `/s/:shareId` (legacy `/share/:shareId`).
- **Disable share (master switch)**:
  - Owners can toggle **Share enabled** off to take a link offline without deleting the doc.
  - When disabled, recipients visiting `/s/:shareId` see a “This document is no longer shared” screen (and the PDF/history endpoints behave as not found).
- **Password protect share link**:
  - Owner can set/remove a share password via `/api/docs/:docId/share-password`.
  - When enabled, recipients must unlock via `/api/share/:shareId/unlock` which sets a per-share cookie.
- **Allow PDF download**:
  - Toggle whether recipients can download the PDF from the share page.
  - When disabled, the share viewer still shows a **Download** button, but clicking it opens a **request download** modal:
    - Receiver enters their email.
    - Receiver gets a confirmation email that their request was sent.
    - Owner receives an email to approve/deny.
    - If approved, the receiver gets an email with a `/download/:token` link to **download** or **save into their account** (sign-in required).
- **Allow recipients to view revision history**:
  - Toggle whether recipients can view a **light** revision history (version + date + summary) from the share page.
  - When available, each revision also includes **page-numbered change hints** so recipients can click a changed page and jump to it in the viewer.
- **Receiver relevance checklist toggle**:
  - Owner can enable a receiver-facing relevance checklist in the share viewer (feature flag stored on the doc).

## Recipient share view (`/s/:shareId`)

- **Public share page**:
  - If the owner disables sharing, the page shows **“This document is no longer shared”** (share-disabled behaves like not found).
  - If the PDF isn’t available yet, shows a “preparing” fallback with an image preview (if present).
  - The viewer includes an **All pages** mode (scroll the full document) and a **Grid** mode (thumbnail overview of all pages, click to open).
  - Grid and All-pages views are responsive and fit to the available viewport width by default.
  - In **Single page** mode, clicking past the first/last page shows a tiny “First page” / “Last page” hint (semi-transparent, fades away).
- **Optional revision history**:
  - If enabled by the owner, recipients can open a **Revision history** modal that shows a light list of updates (no owner-only details).
  - The history modal is optimized for speed: it **prefetches** the first page of history in the background and loads additional items **lazily as you scroll**.
- **Password gate** (optional):
  - If a share password is configured, the share page requires a successful unlock cookie before rendering.
  - The password screen includes a quick **preview thumbnail** (when available) that preserves the thumbnail's aspect ratio to help recipients confirm they're unlocking the right doc.
  - The password screen header uses the user's selected **global theme branding** (dark/light).
- **Same-origin PDF proxy for recipients**:
  - Recipient PDF loads from `/s/:shareId/pdf` (supports `?download=1` when downloads are enabled).
- **Open Graph / Twitter metadata**:
  - Dynamic metadata is generated from stored AI output fields when available.
  - OG image prefers the doc's preview thumbnail when present (otherwise falls back to `/s/:shareId/og.png`).
- **Share view tracking**:
  - Server endpoints exist for share stats and admin inspection of share views.
  - Best-effort **time spent** and **per-page dwell time** are recorded for share viewers (counts foreground time only; increments on page changes and tab hide/close; periodic flush).
- **Introduce yourself (optional)**:
  - On the share page, viewers can optionally provide a **name + email** (“Introduce yourself”).
  - The browser stores this info (best-effort) and includes it with share-view tracking so the owner’s Metrics page can label otherwise-anonymous viewers.

## AI & review features

- **AI “snapshot” extraction**:
  - The system can analyze extracted PDF text (and best-effort per-page slide images) and store a structured AI output payload (used in both owner UI and share metadata).
  - Owner share panel surfaces a condensed “AI snapshot” and allows viewing the full snapshot.
- **Doc reviews**:
  - `/doc/:docId/review` page and `/api/docs/:docId/reviews` API for listing reviews.
  - `/api/docs/:docId/report` API for generating/saving a report (review-like artifact).
- **Tags**:
  - `/api/tags/:tag/docs` lists docs that contain a specific AI-derived tag (paged).

## Usage & limits

- **Credits (billing-cycle-based)**:
  - Pro includes **300 credits per Stripe billing cycle** (subscription anniversary, not calendar month).
  - Included credits **reset to 300** on renewal (no rollover). Purchased credits (if present) do not expire.
  - Free workspaces include a **one-time 50 credits** starter grant (no reset).
  - Customer UI exposes **credits and quality tiers only** (no tokens or provider raw costs).
- **Limits (credits-first)**:
  - Dashboard includes a **Limits** page (`/dashboard/limits`) for workspace owners/admins to manage on-demand usage caps (credits-first; dollars are secondary).
  - Legacy `/dashboard/spending` redirects to the Limits page.
  - Limits page includes **AI Quality Defaults** (workspace-level):
    - **Summary** defaults to **Basic** (automatic; not configurable)
    - **Review** default: **Basic**, **Standard**, or **Advanced**
    - **History** default: **Basic**, **Standard**, or **Advanced**
  - Limits page includes a **Deep Research** section (early access): currently being tested with a small set of users; email `hi@lnkdrp.com` to join the waiting list.
  - On-demand limits are **Pro-only**. Workspace owners/admins can set an **on-demand spend limit per billing cycle** (Cursor-style presets + custom).
  - If the limit is `0`, on-demand usage is disabled (hard-blocked).
  - The **Usage** tab (`/dashboard?tab=usage`) is **operational truth**:
    - Includes the same **Plan** status card as Overview (manage subscription / upgrade + on-demand module when applicable).
    - Shows a **Credits** summary (remaining, included/extra breakdown, cycle reset date), a **Daily usage** chart (by model route), and a **Usage** log table (even when empty).
    - Credits “Used” also shows an **estimated USD equivalent** at the canonical on-demand rate ($0.10/credit) for quick intuition (not an invoice amount).
    - Does **not** show Free-vs-Pro plan comparison cards.
    - Free plan shows at most one **Upgrade** CTA; full subscription upsell/plan comparison lives on the **Overview** tab.

## Requests (document link request repositories)

- **Technical reference**:
  - See `docs/REQUEST.md` for request-repo schema, endpoints, and request-review (Intel) agent behavior.

- **Search docs** (left sidebar):
  - The left sidebar includes a **Search** action (above Upload/Request) that opens the **Docs** modal and focuses the search input.
  - Search is backed by `GET /api/docs?q=...` (same query used by the Docs modal).

- **Create a request link** (left sidebar):
  - A request is treated like a **folder/repository of documents**.
  - You can share the link with multiple people; each upload becomes a new doc in that request folder.
  - Public recipient upload page: `/request/:token` (legacy: `/r/:token`)
  - The request repo page shows both the **Request link** (uploads enabled) and a **Request view** link (read-only).
  - Request repo list page (owner): `/requests` (lists request repositories/inboxes; matches the “Received” sidebar section).
- **View-only link (recipient)**:
  - Public recipient viewer page: `/request-view/:token`
  - Allows viewing docs inside a request repo **without enabling uploads** and without requiring sign-in.
- **Anti-abuse (public uploads)**:
  - Recipient uploads can be configured to **require sign-in** (per request repo).
  - When sign-in is not required, the app uses a lightweight per-browser bot/device id header (`x-lnkdrp-botid`) to reduce abuse.
- **Recipient upload UX**:
  - The public upload page shows step-by-step status (uploading → finalizing → processing) and warns the user to keep the tab open because processing happens in the browser session.
  - While an upload is in progress, the page shows a full-screen “Processing” overlay and the browser will warn if the user tries to close/refresh the tab.
  - After a successful upload, the page shows a clear “upload successful” confirmation and renders a preview of the last uploaded document (saved locally per request link).
- **Requester review (“Intel”)**:
  - For docs received via request links, the doc header shows an **Intel** icon (instead of Metrics) that opens the latest review agent output.
  - Request-received docs use a distinct doc template:
    - The header shows an “uploaded into <request repo>” indicator (tray icon). On desktop it’s placed on the right to keep the top bar height stable.
    - No share link UI / no download toggle / no metrics (to avoid confusion with owner docs).
    - Includes a **Replace link** control that copies a per-doc update link (`/doc/update/:code`) so the owner can let someone upload a new version of that specific received doc.
  - Docs lists show request context indicators:
    - Request-received docs show an inbound/tray icon that links back to the originating request repo.
    - Guide docs show a guide/lightbulb icon that links back to the request repo using that guide.
  - Docs can be **starred from within a request repository doc list** (uses a star icon).
  - Request-received doc detail pages (`/doc/:docId`) also include a star toggle in the header.
  - Intel is shown inline on the right as a short markdown summary of **Guide vs Deck** alignment, with **Relevancy** + **Stage match** shown at the top.
  - While Intel is being generated (queued/processing), the doc viewer shows a full-document processing overlay so the “review running” state is obvious.
  - The full structured output (stage match + relevancy + reasons + strengths/weaknesses + open questions + founder note) is stored on the Review record and is currently surfaced in **admin** for debugging.

## Sharing (public share links)
  - Recipient views omit owner-only controls like metrics.
  - Owner views show a **Visible to you only** indicator along with share view stats.
- **Optional review agent per request**:
  - Enable “review agent” on a request to score each uploaded deck for relevancy/alignment to your Guide + reviewer notes.
  - For now, only **VC → founder** reviews are supported (VC template + customization).
  - The reviewer agent type is selected from a server-managed list (currently only **Venture Capitalist**).
  - The review agent infers the document’s stage/maturity (best-effort) and calibrates expectations accordingly (e.g., it should not penalize pre-seed decks for not having later-stage financial projections).
  - A **guide document** (investor thesis / RFP / job description) must be attached to enable automatic review and is used as additional context for the review agent.
  - Manual **“Rerun review”** (from a received doc’s Intel panel) uses the request-review agent output when configured; if the request-review agent is disabled or missing a guide, the review is marked as **skipped** with a clear explanation so the UI doesn’t hang polling.
  - Guide documents can be attached as a **PDF** (kept small; currently **max 1MB**) or as **pasted guide text** (stored as a lightweight doc whose extracted text is used by the agent).
  - Request link repos have settings in the project view for: link URL, review agent, prompt templates, and guide document attachment.

## Projects

- **Project CRUD**:
  - `/api/projects` (list/create) and `/api/projects/:projectSlug` (update/delete).
- **Quick feedback on slow navigation/ops**:
  - Clicking a project in the left sidebar shows a full-screen **Loading project…** overlay immediately (so it doesn’t feel frozen).
  - Assigning a doc to a project from the doc actions menu shows an inline **spinner** while the add/remove completes.
- **Create from left sidebar**:
  - The left sidebar **Projects** section includes a **New project** row to create a new project without leaving the current page.
- **List docs for a project**:
  - `/api/projects/:projectSlug/docs`.
- **Project page**:
  - `/project/:projectSlug` (app shell) and public-ish route under `/p/:projectSlug` (as present in routing).
  - The public `/p/:projectSlug` view shows the project name/description and a list of shared documents (header is branding-only; no viewer controls).

## Admin tools

- **Admin home**: `/a`
- **Tools → Cache**: `/a/tools/cache`
  - Inspect browser localStorage keys/values and clear app caches (useful for debugging navigation/data state during development).
  - Clear actions use a quick click-to-confirm UI (avoids relying on browser confirm dialogs).
  - “Clear app cache” clears `lnkdrp*` localStorage keys (including both `lnkdrp-*` and `lnkdrp.*` variants).
- **Tools → Billing**: `/a/tools/billing`
  - Refresh and inspect billing UI config stored in MongoDB (e.g. Pro price label).
  - Uses `POST /api/admin/billing/pro-price` to refresh from Stripe; dashboard reads do not call Stripe.
- **AI runs**: `/a/ai-runs`
  - API: `/api/admin/ai-runs` and `/api/admin/ai-runs/:runId`
  - Lists prompt + output logs for AI features (review agent and PDF analysis) to aid debugging.
- **Users → Invites**: `/a/invitecodes`
  - APIs: `/api/invites/codes` and `/api/invites/codes/:inviteId/toggle-active`
  - Approve invite requests: `/api/invites/requests` and `/api/invites/requests/:requestId/approve`
- **Metrics → Share views**: `/a/shareviews`
  - APIs: `/api/admin/shareviews/recent` and `/api/admin/shareviews/doc/:docId`
  - Captures and displays a best-effort `viewerIp` for each share view (from proxy headers like `x-forwarded-for`).
- **Data → Users**: `/a/data/users`
  - API: `/api/admin/data/users`
  - Drilldown: `/a/data/users/:userId` (API: `/api/admin/data/users/:userId`)
  - Supports filtering by role and sorting by created/last login (admin UI convenience).
  - Supports deactivating users (sets `isActive=false`).
  - Can admin-override a user’s billing `plan` (Free/Pro) for testing via `/api/admin/users/:userId/plan` (Stripe remains the source of truth in production).
- **Data → Workspaces**: `/a/data/workspaces`
  - API: `/api/admin/data/workspaces` (paged)
  - Drilldown: `/a/data/workspaces/:workspaceId` (API: `/api/admin/data/workspaces/:workspaceId/members`)
  - Supports filtering by type (personal/team) and sorting by created/updated.
  - Drilldown shows workspace metadata (type/slug/created/updated/ids) and members (org membership roles + user metadata).
- **Data → Projects**: `/a/data/projects`
  - API: `/api/admin/data/projects`
  - Drilldown/editor: `/a/data/projects/:projectId` (API: `/api/admin/data/projects/:projectId`)
  - Supports manual updates (e.g. setting `isRequest=true` for request repos that have a `requestUploadToken`).
  - Supports soft-delete (admin action).
- **Data → Docs**: `/a/data/docs`
  - API: `/api/admin/data/docs`
  - Supports filtering by status/archived, sorting by created/updated, and soft-delete (admin action).
  - Drilldown: click a doc row to view **full doc JSON** plus related **uploads**; click an upload to view full upload JSON (including `error.details.preview` when thumbnail generation fails).
- **Data → Requests**: `/a/data/requests`
  - API: `/api/admin/data/requests`
  - Drilldown: `/a/data/requests/:requestId` (API: `/api/admin/data/requests/:requestId`)
  - Supports soft-delete (admin action).
  - Drilldown includes raw request/project JSON plus related docs/uploads and reviews:
    - Shows `aiOutput` when present (doc + upload).
    - Shows review output (`Review.outputMarkdown`) plus structured agent output (`Review.agentOutput`) when present.
    - Shows related AI run logs and (per run) full prompts + outputs via `/api/admin/ai-runs/:runId`.
  - Drilldown includes copy-to-clipboard actions for individual blocks (prompts/outputs/JSON) and a “copy all (loaded)” action.
    - Shows an **AI runs** tab (filtered to this request repo) for quickly locating the exact prompts/outputs used.
- **Data → Uploads**: `/a/data/uploads`
  - API: `/api/admin/data/uploads`
  - Supports soft-delete (admin action).
  - Drilldown: click an upload row to view **full upload JSON** (includes artifact pointers like `previewImageUrl` and error details).
- **System → Cron health**: `/a/cron-health`
  - API: `/api/admin/cron-health`
  - Shows latest heartbeat snapshots written by cron endpoints (status/duration/last error).
- **System → Error events (Mongo ErrorEvent)**
  - API: `/api/admin/errors` (filters + cursor pagination)

## Revision history (in progress)

- **Record-level revision history**:
  - We are adding revision history for key records (e.g. docs/projects/requests), capturing **what changed** (field-level details / before-after) along with **when** it changed and best-effort **who/what** initiated the change (user vs system/automation).

## Debug & utilities

- **Debug endpoint**: `/api/debug` (env wiring / server sanity checks)


