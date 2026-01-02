# Features

**Maintenance:** Update this file whenever you change user-facing behavior (pages/routes, uploads, sharing/passwords/downloads, AI/reviews/metrics, projects, invites/auth, admin tools).

This document is a **product-oriented** breakdown of the main user-facing features currently implemented in this repo.

## Core concepts

- **Organization (Org)**: The top-level tenancy boundary. Every user has a 1:1 **Personal org** and can create additional orgs. Most records (projects/docs/uploads) are scoped to an org, and the UI uses an **active org** context.
- **Doc**: A PDF-backed document record with a title, processing status, extracted text, preview image, AI output, and a public `shareId` (alphanumeric only; so share URLs don’t expose Mongo `_id`).
- **Upload**: An upload record representing an incoming file (or imported URL) and its processing pipeline (store in Blob, extract text, generate preview, run AI).
- **Share link**: A public, recipient-facing page at `/s/:shareId` (legacy: `/share/:shareId`) that can optionally be password-protected and optionally allow PDF download.
- **Project**: A container that groups docs; docs can belong to multiple projects (`projectIds`) with a backward-compatible “primary” `projectId`.
- **Invite gating**: The unauthenticated experience is gated behind an invite cookie (invite code verification + request flow).

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
  - A settings hub for account/workspace/usage/spending/billing (currently a shell UI; actions like account deletion and billing portal are not yet wired up).
  - Supports deep links via `/preferences?tab=billing` (and pretty URLs like `/preferences/billing`).

## Dashboard (account + workspace hub)

- **Dashboard page**: `/dashboard`
  - Cursor-like standalone settings/analytics hub with a left mini-nav.
  - Includes an **Overview** tab (default) that shows high-level workspace stats (e.g. new docs, pages viewed, share views) plus a **30-day activity graph** aggregated across all docs in the active workspace.
  - Overview includes a **Subscription** card at the top:
    - Shows current plan (Free vs paid status) for the active workspace.
    - Free plan includes a **Subscribe** button (Stripe checkout link).
    - Paid workspaces include a **Manage subscription** button (Stripe billing portal session).
    - Includes a quick link to **Usage** (placeholder for now).
  - Includes a **Contact Us** item in the left menu that opens a modal with the support email (`hi@lnkdrp.com`).
  - Account tab includes an **Edit name** modal (updates the signed-in user's display name).
  - User avatar UI uses **initials** (we do not display the Google profile image).
  - Workspaces can have an optional **workspace icon** (org avatar); recommended requirements: **square (1:1), at least 120×120**, and ≤ 2MB.

## Organizations & org switching

- **Org list + create**:
  - API: `/api/orgs` (list + create a new team org).
  - The client **preloads and caches** the org list on page load (best-effort `localStorage`) so the workspace switcher opens instantly.
- **Active org**:
  - The app tracks an “active org” in the signed-in session (JWT claim) and uses it to scope core data APIs (projects/docs/requests).
  - Workspace switching/management is available in **Preferences** (`/preferences`).
  - The active workspace indicator is shown in the UI near the top-left brand/logo area (best-effort, client-side indicator). If the workspace has an icon (org avatar), it’s shown next to the workspace name.
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
  - Create a doc record, create an upload record, then start a Blob client-upload + processing pipeline.
- **Upload via URL (import a PDF link)**:
  - Create doc + upload, ask the server to fetch the PDF into the upload (`/api/uploads/:uploadId/import-url`), then trigger processing (`/api/uploads/:uploadId/process`).
  - After processing, the doc title may be **auto-renamed** using the AI-derived document name (so URL uploads don’t end up named like `view`/`uc`).
- **Client upload test page**:
  - `/test/client-upload` (and redirect from `/client-upload`) exercises the Vercel Blob “client uploads” flow via `/api/blob/upload`.

## Doc view (owner)

- **Doc page**: `/doc/:docId`
  - Shows doc status (`draft`/`preparing`/`ready`/`failed`) and updates as processing completes.
  - PDF viewing via `PdfJsViewer` once the PDF is ready (owner uses a same-origin cached PDF proxy at `/api/docs/:docId/pdf`).
- **Starred docs**:
  - Client-side “star” state with a local cache and change events.
- **Assign docs to projects**:
  - UI for viewing/adjusting project membership (multi-project aware).

## Sharing (owner controls)

- **Generate/copy share link**:
  - Share links are based on `shareId` (alphanumeric only) and resolve to `/s/:shareId` (legacy `/share/:shareId`).
- **Password protect share link**:
  - Owner can set/remove a share password via `/api/docs/:docId/share-password`.
  - When enabled, recipients must unlock via `/api/share/:shareId/unlock` which sets a per-share cookie.
- **Allow PDF download**:
  - Toggle whether recipients can download the PDF from the share page.
- **Receiver relevance checklist toggle**:
  - Owner can enable a receiver-facing relevance checklist in the share viewer (feature flag stored on the doc).

## Recipient share view (`/s/:shareId`)

- **Public share page**:
  - Renders a PDF viewer when the PDF is available; otherwise shows a “preparing” fallback with an image preview (if present).
- **Password gate** (optional):
  - If a share password is configured, the share page requires a successful unlock cookie before rendering.
  - The password screen includes a quick **preview thumbnail** (when available) to help recipients confirm they're unlocking the right doc.
- **Same-origin PDF proxy for recipients**:
  - Recipient PDF loads from `/s/:shareId/pdf` (supports `?download=1` when downloads are enabled).
- **Open Graph / Twitter metadata**:
  - Dynamic metadata is generated from stored AI output fields when available.
  - OG image prefers the doc's preview thumbnail when present (otherwise falls back to `/s/:shareId/og.png`).
- **Share view tracking**:
  - Server endpoints exist for share stats and admin inspection of share views.

## AI & review features

- **AI “snapshot” extraction**:
  - The system can analyze extracted PDF text and store a structured AI output payload (used in both owner UI and share metadata).
  - Owner share panel surfaces a condensed “AI snapshot” and allows viewing the full snapshot.
- **Doc reviews**:
  - `/doc/:docId/review` page and `/api/docs/:docId/reviews` API for listing reviews.
  - `/api/docs/:docId/report` API for generating/saving a report (review-like artifact).
- **Tags**:
  - `/api/tags/:tag/docs` lists docs that contain a specific AI-derived tag (paged).

## Requests (document link request repositories)

- **Technical reference**:
  - See `docs/REQUEST.md` for request-repo schema, endpoints, and request-review (Intel) agent behavior.

- **Create a request link** (left sidebar):
  - A request is treated like a **folder/repository of documents**.
  - You can share the link with multiple people; each upload becomes a new doc in that request folder.
  - Public recipient upload page: `/request/:token` (legacy: `/r/:token`)
  - The request repo page shows both the **Request link** (uploads enabled) and a **Request view** link (read-only).
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
    - The title shows a secondary line: “uploaded into <request repo>” (tray icon).
    - No share link UI / no download toggle / no metrics (to avoid confusion with owner docs).
  - Docs lists show request context indicators:
    - Request-received docs show an inbound/tray icon that links back to the originating request repo.
    - Guide docs show a guide/lightbulb icon that links back to the request repo using that guide.
  - Docs can be **starred from within a request repository doc list** (uses a star icon).
  - Request-received doc detail pages (`/doc/:docId`) also include a star toggle in the header.
  - Intel is shown inline on the right as a short markdown summary of **Guide vs Deck** alignment, with **Relevancy** + **Stage match** shown at the top.
  - While Intel is being generated (queued/processing), the doc viewer shows a full-document processing overlay so the “review running” state is obvious.
  - The full structured output (stage match + relevancy + reasons + strengths/weaknesses + open questions + founder note) is stored on the Review record and is currently surfaced in **admin** for debugging.

## Sharing (public share links)
  - Recipient views are visually marked as **Shared** in the PDF viewer header and omit owner-only controls like metrics.
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
- **List docs for a project**:
  - `/api/projects/:projectSlug/docs`.
- **Project page**:
  - `/project/:projectSlug` (app shell) and public-ish route under `/p/:projectSlug` (as present in routing).

## Admin tools

- **Admin home**: `/a`
- **Tools → Cache**: `/a/tools/cache`
  - Inspect browser localStorage keys/values and clear app caches (useful for debugging navigation/data state during development).
  - Clear actions use a quick click-to-confirm UI (avoids relying on browser confirm dialogs).
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
  - Includes an org picker for viewing users/memberships for any org (API: `/api/admin/data/orgs` + `/api/admin/data/orgs/:orgId/members`).
- **Data → Projects**: `/a/data/projects`
  - API: `/api/admin/data/projects`
  - Drilldown/editor: `/a/data/projects/:projectId` (API: `/api/admin/data/projects/:projectId`)
  - Supports manual updates (e.g. setting `isRequest=true` for request repos that have a `requestUploadToken`).
- **Data → Docs**: `/a/data/docs`
  - API: `/api/admin/data/docs`
- **Data → Requests**: `/a/data/requests`
  - API: `/api/admin/data/requests`
  - Drilldown: `/a/data/requests/:requestId` (API: `/api/admin/data/requests/:requestId`)
  - Drilldown includes raw request/project JSON plus related docs/uploads and reviews:
    - Shows `aiOutput` when present (doc + upload).
    - Shows review output (`Review.outputMarkdown`) plus structured agent output (`Review.agentOutput`) when present.
    - Shows related AI run logs and (per run) full prompts + outputs via `/api/admin/ai-runs/:runId`.
  - Drilldown includes copy-to-clipboard actions for individual blocks (prompts/outputs/JSON) and a “copy all (loaded)” action.
    - Shows an **AI runs** tab (filtered to this request repo) for quickly locating the exact prompts/outputs used.
- **Data → Uploads**: `/a/data/uploads`
  - API: `/api/admin/data/uploads`
- **System → Cron health**: `/a/cron-health`
  - API: `/api/admin/cron-health`
  - Shows latest heartbeat snapshots written by cron endpoints (status/duration/last error).

## Debug & utilities

- **Debug endpoint**: `/api/debug` (env wiring / server sanity checks)


