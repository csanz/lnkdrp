# Cursor rules & repo maps

This repo uses **Cursor rules** plus two human-maintained maps:

- `@INDEX.md` — **code map** (file map + exported APIs/components/pages/routes)
- `@docs/FEATURES.md` — **product map** (user-facing behavior and flows)

The goal is to keep changes **intentional**, **reviewable**, and **easy to navigate**.

## How we use Cursor rules in this repo

The active Cursor rules live in `.cursorrules` and are intentionally opinionated:

- **No unasked changes**: only change what the request requires.
- **Propose extras first**: if an improvement is outside the request, propose it and wait for approval.
- **Keep scope tight**: prefer small, localized diffs over broad refactors.
- **Start with the maps**: to find where something lives, open `@INDEX.md` first, then `@docs/FEATURES.md` for user-facing intent.
- **Keep the maps accurate**:
  - When adding/removing/moving files, or changing exported APIs/components/pages/routes, update `INDEX.md` in the same change.
  - When changing user-facing behavior/flows, update `docs/FEATURES.md` in the same change.
- **Route/page doc header**: when editing/adding pages or API routes under `src/app/**`, include a short top-of-file comment describing purpose and route.
- **Library doc comments**: when editing/adding libraries under `src/lib/**`, add short doc comments for exported symbols when non-obvious.

## `@INDEX.md` format (code map)

`INDEX.md` is a **navigation + API surface** document. It should answer:

- “Where is this implemented?”
- “What does this file export?”
- “What route/methods exist for this API endpoint?”

### Conventions

- **One bullet per file** (generally).
- Use backticks for paths: `` `src/.../file.ts` ``.
- After the path, include a short description using an em dash `—`.
- Prefer describing **exports** and **public behavior**, not internal details.
- Use **sub-bullets** for structured APIs (e.g. HTTP methods, exported functions/types).

### Typical patterns

- **Components**:
  - `src/components/Foo.tsx` — exports: Foo. Props: `...` (only when important)
- **Pages**:
  - `src/app/(app)/doc/[docId]/page.tsx` — Page for `/doc/:docId`.
- **API routes**:
  - `src/app/api/starred/route.ts` — API route for `/api/starred`.
    - GET (function) — List starred docs...
    - POST (function) — Toggle starred state...
    - runtime (const) — Next.js route configuration.
- **Libraries**:
  - `src/lib/foo.ts`
    - someExport (function) — One-line description.
    - SomeType (type) — One-line description.

### What “keep it up to date” means

Update `INDEX.md` whenever you:

- add/remove/rename/move a file that’s part of the app’s surface area
- add/remove/rename a meaningful export from a component or library
- add/remove a page route or API route
- change an API route’s supported methods or shape in a way that affects callers

## `@docs/FEATURES.md` format (product map)

`docs/FEATURES.md` is a **product-oriented** breakdown of what the app does. It should answer:

- “What can users do?”
- “What’s the flow and the rules?”
- “Which pages/routes are involved?”

### Conventions

- Organized into `##` sections by feature area (auth, dashboard, sharing, uploads, etc).
- Use bullets with short, direct statements.
- Call out important routes explicitly (e.g. `/dashboard`, `/s/:shareId`, `/api/...`).
- Prefer describing **user-visible outcomes**, **constraints**, and **gating** (not implementation details).

### What “keep it up to date” means

Update `docs/FEATURES.md` whenever you change **user-facing behavior** such as:

- new/changed pages or routes
- sharing behavior (passwords/downloads/history visibility)
- upload pipeline or processing UX
- auth/invite gating behavior
- AI/review/metrics behavior
- admin tools behavior (when it changes what admins can do or see)

## Practical workflow

- **Finding code**: start at `@INDEX.md` (jump to the relevant section: Pages/API/Libraries).
- **Understanding intent**: cross-check `@docs/FEATURES.md` for expected UX/flow.
- **Making changes**:
  - implement the requested change
  - update `INDEX.md` and/or `docs/FEATURES.md` if required by the rules
  - keep diffs small and explainable

## Prompt: initialize/refresh `INDEX.md` and `docs/FEATURES.md`

Copy/paste this prompt into Cursor when you want an agent to (re)initialize or do a cleanup pass on the two documents. Adjust the “Scope” section as needed.

```text
You are working in the repo `www_lnkdrp`. Your job is to initialize or refresh two human-maintained docs:

1) `INDEX.md` — code map (file map + exported APIs/components/pages/routes)
2) `docs/FEATURES.md` — product map (user-facing behavior and flows)

Constraints:
- Follow `.cursorrules` strictly.
- Do not change application code unless explicitly asked. This task is docs-only.
- Keep edits narrowly scoped; do not invent features or exports that are not present.

Scope:
- Target directories to map: `src/`, `docs/`, `scripts/`, `db/migration/`, root config files.
- Exclude: `node_modules/`, `.git/`, `.next/`, build outputs, dot-dirs, `.env*`, `.DS_Store`, `tmp/` (unless explicitly asked).

Deliverables:
## A) Update `INDEX.md`
- Keep the existing high-level section structure (e.g. Components, Lib, Pages, Deployment, Libraries, Files).
- Use one bullet per file where possible:
  - `path` — short description.
- For files that export multiple public symbols, use sub-bullets:
  - exportName (function/type/const) — one-line purpose.
- For `src/app/**` pages, use: “Page for `/route`”.
- For `src/app/api/**/route.ts`, use: “API route for `/api/...`” plus method sub-bullets (GET/POST/PATCH/DELETE) when present.
- Prefer “exports: X” on component bullets when that’s the primary value.
- Do not list every internal helper if it’s not part of the useful surface area; prioritize navigability.

## B) Update `docs/FEATURES.md`
- Keep it product-oriented and organized by `##` feature areas.
- Describe user-visible behavior, flows, constraints, and gating.
- Reference key routes explicitly (e.g. `/dashboard`, `/s/:shareId`, `/api/...`) but avoid implementation details.
- Do not add features that aren’t implemented; if something is unclear, omit it.

Output requirements:
- Make the smallest reasonable diffs that bring both docs up to date.
- If you add a new docs file, ensure `INDEX.md` references it in the docs list.
```

