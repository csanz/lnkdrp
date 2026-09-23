# Cursor rules & repo maps

This repo uses **Cursor rules** plus two maps:

- `@INDEX.md` — **code map**, *generated* from the filesystem: every source file, the URL it serves
  where it is a route, and its exported names. Never hand-edit it; run `npm run index`.
- `@docs/FEATURES.md` — **product map** (user-facing behavior and flows), maintained by hand

The goal is to keep changes **intentional**, **reviewable**, and **easy to navigate**.

## How we use Cursor rules in this repo

The active Cursor rules live in `.cursorrules` and are intentionally opinionated:

- **No unasked changes**: only change what the request requires.
- **Propose extras first**: if an improvement is outside the request, propose it and wait for approval.
- **Keep scope tight**: prefer small, localized diffs over broad refactors.
- **Start with the maps**: to find where something lives, open `@INDEX.md` first, then `@docs/FEATURES.md` for user-facing intent.
- **Keep the maps accurate**:
  - After adding, removing or moving files, run `npm run index` to regenerate `INDEX.md`.
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

Run `npm run index`. That is the whole procedure — the file is generated from the filesystem, so
adding, moving or deleting a file, or changing what it exports, is picked up automatically.

It was not always so. The map was maintained by hand under a rule that said to update it "in the
same change (no exceptions)"; it was last updated on 2026-03-05 and then not again, and by
2026-09-23 it listed 413 paths against 762 files in `src/` alone, 36 of them gone, including a
whole deleted invite-code subsystem — while this document told everyone to open it first. A rule
that depends on remembering is the rule that breaks, so it does not depend on remembering any
more: `npm run index -- --check` and `tests/lib/indexMap.test.ts` fail when it drifts.

What the generator cannot produce is *why a file exists*. That belongs in the file's own header
comment, next to the code it describes, and in `docs/FEATURES.md` for user-facing intent.

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
  - run `npm run index` if you added, moved or removed a file; update `docs/FEATURES.md` if the
    change is user-facing
  - keep diffs small and explainable

## Prompt: refresh `docs/FEATURES.md`

`INDEX.md` needs no prompt — run `npm run index`. This one is for the product map, which is
written by hand because it describes intent, and intent cannot be read off the filesystem.

```text
You are working in the repo `www_lnkdrp`. Refresh `docs/FEATURES.md`, the product map.

Constraints:
- Follow `.cursorrules` strictly.
- Docs only: do not change application code.
- Do not invent features. If something is unclear, read the code; if it is still unclear, omit it.

Method:
- Work from the code, not from the existing text — the failure mode of this document is a
  sentence that was true once. Where it states a number (plan caps, credit grants, day counts),
  check it against the constant and cite the constant by name rather than restating the digit.
- Where a page or route is named, confirm it exists and that something in the product links to it.

Shape:
- Product-oriented, organized by `##` feature area.
- Describe user-visible behavior, flows, constraints and gating; name routes (`/dashboard`,
  `/s/:shareId`, `/api/…`) but stay out of implementation detail.
- Smallest reasonable diff.
```
