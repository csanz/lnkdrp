# Deploy 1 — First deployment checklist + plan

This document is the **runbook for the first production deployment** of `www_lnkdrp`.

If/when you do a future “big” deployment (architecture change, billing revamp, etc), create a new doc in this folder (e.g. `Deploy_2.md`) and keep this one immutable as historical record.

## Checklist (first deployment)

### Project setup (Vercel)
- [ ] Create a Vercel project from this repo.
- [ ] Confirm **Production domain** (the canonical user-facing domain).
- [ ] Confirm Node runtime is used where required (App Router routes with `runtime = "nodejs"` already exist in code).

### Required environment variables (Vercel → Production)

### How to get / generate production keys (quick reference)

#### Generate strong secrets locally (recommended)
- For these env vars, you should generate **new random secrets** for production:
  - `NEXTAUTH_SECRET`
  - `CRON_SECRET` (preferred; `LNKDRP_CRON_SECRET` is the legacy fallback)
  - `LNKDRP_SHARE_PASSWORD_SECRET`
  - `LNKDRP_ORG_INVITE_TOKEN_SECRET`

You can generate them with the included script:
- Run: `node scripts/gen-env-secrets.mjs`
- Copy the printed `KEY="value"` lines into Vercel env vars.

Alternatively, one-off commands:
- `openssl rand -base64 48` (Mac/Linux)
- `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`

#### MongoDB (`MONGODB_URI`, `MONGODB_DB_NAME`)
- **Where to get it**:
  - MongoDB Atlas: Project → Database → “Connect” → “Drivers” → copy the connection string
  - Link: `https://cloud.mongodb.com/`
- **Notes**:
  - Use a dedicated production database/user.
  - Prefer IP allowlisting / network controls appropriate to your security posture.

#### Google OAuth (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`)
- **Where to get it**:
  - Google Cloud Console → APIs & Services → Credentials → Create Credentials → OAuth client ID
  - Link: `https://console.cloud.google.com/apis/credentials`
- **Must configure**:
  - Authorized redirect URI: `https://<DOMAIN>/api/auth/callback/google`
- **Recommendation**:
  - Use a separate OAuth client for production (clean separation from dev/staging).

#### Vercel Blob (`BLOB_READ_WRITE_TOKEN`)
- **Where to get it**:
  - Vercel Project → Storage → Blob → create/rotate a Read/Write token
  - Docs: `https://vercel.com/docs/vercel-blob`
- **Verification**:
  - (Local) `npm run blob:test` (requires `BLOB_READ_WRITE_TOKEN` locally in `.env.local`).

#### Stripe (`STRIPE_*`, `NEXT_PUBLIC_STRIPE_*`)
- **Where to get keys**:
  - Stripe Dashboard → Developers → API keys (switch to **Live mode** for production)
  - Link: `https://dashboard.stripe.com/apikeys`
- **Webhook secret** (`STRIPE_WEBHOOK_SECRET`):
  - Stripe Dashboard → Developers → Webhooks → add endpoint `https://<DOMAIN>/api/stripe/webhook`
  - Copy the endpoint’s “Signing secret”
  - Link: `https://dashboard.stripe.com/webhooks`
- **Price IDs** (`STRIPE_PRICE_ID`, `STRIPE_AI_CREDITS_PRICE_ID`):
  - Stripe Dashboard → Products → select product → copy **Live mode** price IDs
  - Link: `https://dashboard.stripe.com/products`
- **Pricing table embed** (`NEXT_PUBLIC_STRIPE_PRICING_TABLE_ID`):
  - If you use Stripe Pricing Tables, create/configure a **Live** pricing table and copy its id.
  - Link (pricing tables): `https://dashboard.stripe.com/pricing-tables`

#### Core
- [ ] `MONGODB_URI`
- [ ] `MONGODB_DB_NAME` (optional)

#### Auth (NextAuth + Google OAuth)
- [ ] `NEXTAUTH_URL` (set explicitly for production)
- [ ] `NEXTAUTH_SECRET`
- [ ] `GOOGLE_CLIENT_ID`
- [ ] `GOOGLE_CLIENT_SECRET`
- [ ] `NEXT_PUBLIC_SITE_URL` (recommended; used for absolute links and public URLs)

#### Storage (Vercel Blob)
- [ ] `BLOB_READ_WRITE_TOKEN`
- [ ] `BLOB_BASE_URL` (recommended: `https://<storeId>.public.blob.vercel-storage.com`; blob URL validation derives the store from the token when unset and **fails closed** in production if neither identifies the store)

#### Billing (Stripe)
- [ ] `STRIPE_SECRET_KEY`
- [ ] `STRIPE_WEBHOOK_SECRET`
- [ ] `STRIPE_PRICE_ID` (subscription price)
- [ ] `STRIPE_AI_CREDITS_PRICE_ID` (metered credits price/item)
- [ ] `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (if using pricing table embed)
- [ ] `NEXT_PUBLIC_STRIPE_PRICING_TABLE_ID` (if using pricing table embed)
- [ ] Optional: `STRIPE_SUCCESS_URL`, `STRIPE_CANCEL_URL` (override redirect URLs)

#### Cron auth (required in production)
- [ ] `CRON_SECRET` (preferred — Vercel Cron sends it automatically as `Authorization: Bearer $CRON_SECRET`)
- [ ] or `LNKDRP_CRON_SECRET` (legacy fallback; used only when `CRON_SECRET` is unset)
- Note: with **neither** set, all `/api/cron/*` routes return `401` in production (fail closed).

#### App-specific secrets (recommended)
- [ ] `LNKDRP_SHARE_PASSWORD_SECRET` (falls back to `NEXTAUTH_SECRET` if unset)
- [ ] `LNKDRP_ORG_INVITE_TOKEN_SECRET` (falls back to `NEXTAUTH_SECRET` if unset)

#### Optional (feature-gated)
- [ ] `OPENAI_API_KEY` (enables the summary/extraction and AI compare features when set; AI review is not released)

### External service configuration

#### Google OAuth
- [ ] Add authorized redirect URI: `https://<DOMAIN>/api/auth/callback/google`
- [ ] Confirm OAuth consent screen + allowed domains match production.

#### Stripe webhooks
- [ ] Create webhook endpoint: `https://<DOMAIN>/api/stripe/webhook`
- [ ] Copy signing secret into `STRIPE_WEBHOOK_SECRET`.
- [ ] Confirm relevant webhook events are enabled (keep aligned with `src/app/api/stripe/webhook/route.ts`).

### Cron jobs (production schedules + auth)
- [ ] Confirm cron schedules in `vercel.json` match desired production behavior (source of truth).
- [ ] Set `CRON_SECRET` in Vercel (Production). Vercel Cron invokes each route with **`GET`** and `Authorization: Bearer $CRON_SECRET`; nothing else to configure.
  - Routes accept both `GET` and `POST` (same handler; `POST` is for manual runs).
  - Manual invocations may also use `x-cron-secret: <secret>` or `?secret=<secret>`.
  - `LNKDRP_CRON_SECRET` is still honored as a legacy fallback when `CRON_SECRET` is unset.
  - Without any secret configured, production cron routes **fail closed** (401).
- [ ] Overlap lease: `notification-emails` and `stripe-credits-reconcile` take a `CronHealth.leaseUntil` lease; a `200 { skipped: "locked" }` response means a previous run is still in progress (auto-expires after ~6 min).
- [ ] Enable the `plan-limits` cron (`/api/cron/plan-limits`, hourly at `:40` in `vercel.json`) — Free plan-limit grace sweep + owner emails; no new env vars (uses `CRON_SECRET`, `RESEND_API_KEY`, `INVITE_EMAIL_FROM`/`NOTIFICATION_EMAIL_FROM`).
- [ ] Verify cron inventory/behavior in `docs/CRON.md`.

### Database migrations
- [ ] Ensure production DB backup/snapshot plan exists (Mongo backup, Atlas snapshot, etc).
- [ ] Run migrations (from a trusted machine with prod DB access):
  - [ ] `node db/migration/run.mjs --dry-run`
  - [ ] `node db/migration/run.mjs`
- [ ] Confirm migrations collection updated (`migrations` collection).

### Preflight (before promoting to Production)
- [ ] `npm ci`
- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] (Optional) run focused tests relevant to changes (vitest suites under `tests/`).

### Production smoke test
- [ ] Visit `/` and confirm app loads.
- [ ] Sign in via Google OAuth.
- [ ] Create/open a doc or dashboard view (confirms Mongo connectivity).
- [ ] Upload a file and verify the upload → process pipeline completes (Blob + server processing).
- [ ] If billing enabled: start an upgrade flow and confirm Stripe webhook updates state.
- [ ] Trigger one cron route manually (`GET` or `POST` with `Authorization: Bearer $CRON_SECRET`) and confirm it returns `200` and updates `CronHealth`.
- [ ] Check `/a/cron-health` to confirm heartbeat snapshots exist and status is `ok`.

### Monitoring (first 24–48h)
- [ ] Watch Vercel logs for 500s/timeouts.
- [ ] Watch Stripe webhook delivery failures and retries.
- [ ] Check cron health periodically (`/a/cron-health`) and investigate `error` runs.

## Deployment plan (Vercel + MongoDB + Stripe + Vercel Blob + Cron)

### Scope / target
- **Hosting**: Vercel (`vercel.json` is configured, including cron schedules).
- **DB**: MongoDB (Mongoose); migrations via `db/migration/run.mjs`.
- **Auth**: NextAuth (Google OAuth).
- **Billing**: Stripe Checkout + `/api/stripe/webhook` as source of truth.
- **Storage**: Vercel Blob.
- **Background jobs**: Vercel Cron → `GET /api/cron/*` with `Authorization: Bearer $CRON_SECRET` (routes also accept `POST`; see `docs/CRON.md` + `vercel.json`).

### Release workflow (repeatable)
- **Preflight**: `npm ci` → `npm run lint` → `npm run build` (and tests as needed).
- **Migrations**: run **before** enabling new behavior; keep migrations backward compatible when possible.
- **Deploy**: validate in Preview deployments; promote to Production.
- **Smoke test**: auth, Mongo, upload/process, billing, cron.
- **Monitor**: Vercel errors, Stripe webhooks, cron health.

### Rollback plan
- **App rollback**: redeploy/promote last known-good Vercel deployment.
- **Cron**: temporarily disable cron jobs (Vercel) or rotate `CRON_SECRET`.
- **DB**: treat migrations as forward-only unless you explicitly implement reversals; prefer hotfix compatibility over DB rollback.

