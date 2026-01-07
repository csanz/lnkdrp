# Benchmarking

This repo includes a small benchmark runner for timing the **dashboard** server requests.

## Prereqs

- Run the Next.js server separately (this script does **not** start it):
  - `npm run dev`
- You must provide an authenticated **Cookie** header.

## Get your Cookie header (recommended: debug endpoint)

- Open the app in your browser (logged in).
- Visit `http://localhost:3001/api/debug/cookie`
- This will **automatically save** your cookie into `scripts/cookie.json`.
- Optionally copy the `cookie` value from the JSON response (for env/flag usage).

Notes:
- This endpoint is **auth-required** and **disabled in production** unless `ALLOW_DEBUG_COOKIE=1`.

## Get your Cookie header (fallback: DevTools)

- Open DevTools → **Network**
- Click any request to `/api/*` (example: `/api/orgs`)
- In **Request Headers**, copy the full **Cookie** header value

## Run: Dashboard benchmarks

Recommended (env var):

```bash
LNKDRP_COOKIE="PASTE_COOKIE_HEADER_VALUE" npm run tests:benchmark -- --dashboard
```

## Run: Left menu (sidebar) benchmarks

This benchmarks the API calls initiated by the **main app left sidebar** (`src/components/LeftSidebar.tsx`):

- Sidebar cache refresh (parallel):
  - `GET /api/docs?limit=5&page=1`
  - `GET /api/projects?limit=10&page=1`
  - `GET /api/requests?limit=10&page=1`
- Starred metadata resolution (best-effort simulation):
  - `GET /api/docs?ids=...`
- Modal opens:
  - `GET /api/docs?limit=20&page=1`
  - `GET /api/projects?limit=20&page=1`
  - `GET /api/requests?limit=20&page=1`
- Delete doc modal (fetch doc to list folders/projects):
  - `GET /api/docs/:docId`

Run:

```bash
npm run tests:benchmark -- --leftmenu
```

Alternative (file):

- If you already visited `http://localhost:3001/api/debug/cookie`, `scripts/cookie.json` should be populated.

- Or paste the cookie into `scripts/cookie.json` manually:

```json
{ "cookie": "PASTE_COOKIE_HEADER_VALUE" }
```

- Then run:

```bash
npm run tests:benchmark -- --dashboard
```

Alternative (flag):

```bash
npm run tests:benchmark -- --dashboard --cookie "PASTE_COOKIE_HEADER_VALUE"
```

## Run: Select a specific dashboard section

```bash
npm run tests:benchmark -- --dashboard --select
```

Run a section directly (no prompt):

```bash
# 7 = Billing & Invoices
npm run tests:benchmark -- --dashboard --select 7
```

Multiple sections:

```bash
# 5 = Usage, 7 = Billing & Invoices
npm run tests:benchmark -- --dashboard --select "5,7"
```

## Common options

- `--iterations 5`: run each request 5 times (summary includes p50/p90/p99)
- `--base-url http://localhost:3001`: override server URL (default is `http://localhost:3001`)
- `--json`: emit JSON output instead of tables

## Notes

- Running `npm run tests:benchmark` without flags will prompt with:
  - Dashboard
  - Admin
- Only **Dashboard** is implemented right now.
- The benchmark runner sends `x-lnkdrp-benchmark: 1` so certain endpoints can bypass server-side in-memory caches and reflect raw DB performance.

## Run: Document page benchmarks (`/doc/:docId`)

Main page (only one implemented so far):

```bash
npm run tests:benchmark -- --document
```

Specify a doc explicitly:

```bash
npm run tests:benchmark -- --document --doc-id YOUR_DOC_OBJECTID
```

Select page(s):

```bash
# 1 = Main Page (Metrics/Share/History are listed but not implemented yet)
npm run tests:benchmark -- --document --select 1
```


