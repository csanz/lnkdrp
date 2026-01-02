# Requests (Inbound upload repositories)

This document is a **technical** description of the “request link” feature: the **schemas** involved, the **API surface**, and how we run the **AI/review agents** differently for request uploads vs normal owner uploads.

## Overview

- A **Request** is implemented as a special kind of **Project** (“request repo”) that:
  - Has a **secret upload token** used by recipients (`/request/:token`).
  - Collects multiple inbound uploads; each inbound upload becomes a new **Doc** under the owner.
  - Optionally runs the **review agent** to produce structured **Intel**.

Routes:
- **Recipient upload page (preferred)**: `/request/:token`
- **Recipient upload page (legacy alias)**: `/r/:token`
- **Recipient view-only page**: `/request-view/:token`
- **Create request (owner)**: `POST /api/requests`
- **Start request upload (recipient)**: `POST /api/requests/:token/uploads`
- **Attach guide doc (owner)**: `POST /api/requests/:requestId/guide` *(implemented under `/api/requests/[token]/guide` but param is a Project ObjectId; see below)*

## Schemas (Mongo/Mongoose)

### `Project` (request repo)

In code, “request repo” behavior expects these fields to exist on Project documents:

- **Base project fields** (declared in `src/lib/models/Project.ts`):
  - `userId: ObjectId` *(owner)*
  - `shareId: string` *(public, for `/p/:shareId`)*
  - `name: string`
  - `slug: string`
  - `description: string`
  - `docCount: number` *(cached active-doc count)*
  - `autoAddFiles: boolean`

- **Request-specific fields** (referenced throughout routes/UI):
  - `isRequest: boolean`
  - `requestUploadToken: string` *(capability secret used by `/request/:token`)*
  - `requestViewToken: string` *(view-only capability secret used by `/request-view/:token`)*
  - `requestRequireAuthToUpload: boolean` *(if true, recipients must be signed in to upload)*
  - `requestReviewEnabled: boolean`
- `requestReviewPrompt: string` *(legacy; UI no longer exposes this; request review behavior is driven by Guide doc + server prompt)*
  - `requestReviewGuideDocId: ObjectId | null` *(optional “guide doc” attached to request)*
  - `isDeleted?: boolean` *(used in some request queries/guards)*

### `Doc` (request-received document)

Request uploads create a normal Doc owned by the requester, but mark it as request-originated:

- **Ownership/membership**
  - `userId: ObjectId` *(owner = requester)*
  - `projectId: ObjectId` *(primary project; set to the request repo)*
  - `projectIds: ObjectId[]` *(includes the request repo)*
- **Request provenance**
  - `receivedViaRequestProjectId: ObjectId | null`
    - Written at creation time for request uploads.
    - Used by owner UI to show **Intel** (review output) instead of owner **Metrics**.
- **Artifacts/processing**
  - `status: "draft" | "preparing" | "ready" | "failed"`
  - `blobUrl`, `previewImageUrl`, `extractedText`, `aiOutput`, etc.

### `Upload` (request upload session)

Request uploads are normal Upload records with one key addition:

- `uploadSecret: string | null`
  - Capability secret that allows a recipient to `GET/PATCH` and trigger processing without auth.
  - Used via HTTP header **`x-upload-secret`**.

Request guide documents also use:

- `skipReview: boolean`
  - When true, the review agent is skipped for that upload (guide docs are prompt context, not review targets).
  - The upload processing route also persists extracted text to a Blob artifact so it can be reused as prompt context.

### `Review` (request review output)

The request review agent stores:

- `status: "queued" | "processing" | "completed" | "failed" | "skipped"`
- `outputMarkdown: string | null` *(human-readable summary; currently `summary_markdown` from the agent output)*
- `agentKind: string | null` *(e.g. `"requestReviewInvestorFocused"`)*
- `agentOutput: object | null` *(structured fields used for admin inspection)*
  - `stage_match: boolean`
  - `notes: string` *(stage fit note only)*
  - `relevancy: "low" | "medium" | "high"`
  - `relevancy_reason: string`
  - `strengths: string[]`
  - `weaknesses: string[]`
  - `key_open_questions: string[]`
  - `summary_markdown: string`
  - `founder_note: string` *(admin-only for now)*
- `agentRawOutputText: string | null` *(raw model text, for debugging)*
- `agentSystemPrompt: string | null`, `agentUserPrompt: string | null` *(exact prompts used; for admin debugging)*
- Prior-review linkage:
  - `priorReviewId`, `priorReviewVersion` (best-effort)

Uniqueness/locking:
- One review per `(docId, version)` enforced via unique index.
- Processing acquires a “lock” by transitioning status to `processing` via `findOneAndUpdate`.

## Public upload API (recipient flow)

### 1) Recipient loads `/request/:token` (or `/r/:token`)

Server page (`src/app/r/[token]/page.tsx`) looks up the request repo by:
- `Project.findOne({ isRequest: true, requestUploadToken: token })`

### 2) Start an upload: `POST /api/requests/:token/uploads`

This route is **unauthenticated by default**, but can be configured to require sign-in:

- If `Project.requestRequireAuthToUpload === true`:
  - Requires an authenticated (signed-in) NextAuth session.
- Otherwise:
  - **Header required**: `x-lnkdrp-botid` (constant `BOT_ID_HEADER`)
- Request body:
  - `originalFileName`
  - `contentType`
  - `sizeBytes`

Response:
- `doc.id`
- `upload.id`
- `upload.secret` *(uploadSecret)*

Behavior:
- Creates a **Doc** owned by the requester:
  - `projectId = request projectId`
  - `projectIds = [request projectId]`
  - `receivedViaRequestProjectId = request projectId`
- Creates an **Upload** for that doc:
  - `status = "uploading"`
  - `version = 1`
  - `uploadSecret = <random base64url secret>`
- Updates the Doc to `status = "preparing"` and links `currentUploadId`.

### 3) Upload bytes to Vercel Blob (client → Blob direct)

Recipient client code (`src/app/r/[token]/pageClient.tsx`) uses `@vercel/blob/client` to upload the selected file to Blob.

### 4) Finalize the upload in our DB: `PATCH /api/uploads/:uploadId`

This call is authorized with:
- **Header**: `x-upload-secret: <uploadSecret>`

Body includes:
- `status: "uploaded"`
- `blobUrl`, `blobPathname`
- `metadata.size`

### 5) Trigger processing: `POST /api/uploads/:uploadId/process`

Also authorized with:
- **Header**: `x-upload-secret: <uploadSecret>`

Client then polls `GET /api/uploads/:uploadId` (also with `x-upload-secret`) until `doc.status === "ready"`.

## Processing pipeline + “different agents”

Upload processing (`src/app/api/uploads/[uploadId]/process/route.ts`) does the same artifact pipeline for all uploads, then conditionally runs different AI agents.

### Artifact pipeline (all uploads)

- Fetch PDF bytes from `Upload.blobUrl`
- Generate preview PNG (best-effort)
- Extract text
  - `pdf-parse` primary
  - PDF.js extraction fallback
- Persist extracted text to Blob (best-effort; bounded) and store `extractedTextBlobUrl/pathname`
- Run the **AI snapshot** analysis (best-effort) and store `Upload.aiOutput` (and later `Doc.aiOutput`)
- Set `Upload.status` to `completed` or `failed`
- Set `Doc.status` to `ready` (or `failed`) — *except one special case below*

### Agent A: “AI snapshot” (`aiOutput`)

This is the general-purpose AI analysis stored on Upload/Doc (used for owner doc UI and share metadata).

Key properties:
- Best-effort and non-fatal (processing continues even if AI snapshot fails).
- Can suggest project routing (auto-add to eligible projects).

### Agent B: “Request review agent” → `Review.outputMarkdown` + `Review.agentOutput`

This is the **request-focused** review that generates structured alignment output (Guide vs Deck).

#### When it runs

- For **request docs**, it runs **only if** the request repo has `requestReviewEnabled === true`.
- If the upload has `skipReview === true`, it is always skipped (used for request guide documents).
- For non-request docs, review may still run depending on broader app behavior, but request docs have an explicit opt-in gate.

#### Prompt construction (“different agents” behavior)

The request review prompt is composed as:
- **System prompt**: loaded from disk (`src/lib/ai/prompts/requestReview/investor_focused/system.md`)
  - plus (optional) `Project.requestReviewPrompt` appended as “requester instructions”
- **User prompt template**: loaded from disk (`src/lib/ai/prompts/requestReview/investor_focused/user.md`)
  - `{{Guide}}` is filled from the guide Doc’s `extractedText` (or legacy `pdfText`)
  - `{{Deck}}` is filled from the uploaded doc’s extracted text

The request review agent returns a single JSON object matching the schema above; `summary_markdown` is also stored into `Review.outputMarkdown` for legacy UI rendering.

#### Concurrency/locking

Review generation is guarded by a per `(docId, version)` lock:
- transitions review status to `processing` via an upsert and status gate.
- avoids duplicate generation via unique index + duplicate key handling.

#### “Ready” gating for request docs

For request docs with review enabled (`requestReviewEnabled === true`), processing deliberately keeps the Doc in `status="preparing"` until the review attempt completes, then flips to `status="ready"`. This ensures the requester sees the viewer + Intel together.

#### Temp-user throttle

If the actor is a **temp user**, review generation is limited to **1 total review per doc** (counted via `ReviewModel.countDocuments({ docId })`).

### Force rerun (owner-only)

The processing route supports `?forceReview=1` (owner-only) to re-run the review agent even when an upload is already completed:
- Resets the existing review state (best-effort) and generates again.
- Still uses the same prompt template + guide doc text + requester instructions.

## Guide documents (request prompt context)

Owners can attach a guide PDF (thesis/RFP/JD) to a request repo:

- First, the owner creates a “guide doc” and uploads it with `skipReview=true` (so it doesn’t generate Intel itself).
- Then the owner calls `POST /api/requests/:requestId/guide` with `{ docId }`.

Note on route parameter naming:
- The guide route is implemented as `src/app/api/requests/[token]/guide/route.ts` for Next.js routing consistency, but the dynamic segment value is a **Project ObjectId** (`requestId`), not the public upload token.

## Security & trust boundaries

- **`requestUploadToken`** is a capability secret granting public upload access to a request repo.
- **`requestViewToken`** is a capability secret granting public view-only access to docs within a request repo.
- **`x-lnkdrp-botid`** is required for recipient uploads to reduce abuse (no login on public links).
- **`uploadSecret` / `x-upload-secret`** scopes authorization to a single upload lifecycle (finalize + process + poll).
- Request review outputs (Intel) are requester/owner-facing; recipients only see the upload flow.


