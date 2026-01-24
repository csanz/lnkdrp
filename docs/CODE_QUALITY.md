# Code quality rules (enforced)

These rules are intentionally **short, explicit, and enforceable**. When in doubt, optimize for **clarity of intent** and **reduced duplication**.

## Documentation comment rules (required)

### What must have a JSDoc block

Add a `/** ... */` JSDoc block **immediately above** every exported:

- **function** (including route handlers like `GET`, `POST`, etc.)
- **React component** (including `export default function ...` and `export const ... = () => ...`)
- **hook** (`use*`)
- **shared utility** in `src/lib/**`
- **class** (rare)

**Lint guardrail**: ESLint warns if you export a function/class/arrow-function without JSDoc.

### Minimum JSDoc content (enforced by review)

Every required JSDoc must include:

- **One-sentence summary** (what it does, not how)
- **Important constraints** (caching, idempotency, side effects, performance caveats) when relevant
- **Security section** when the code touches auth/gating/permissions (see below)

If any parameter/return value is non-obvious, include `@param` / `@returns` (don’t over-document trivial `string`/`boolean` cases).

### Security/auth/gating/permissions (always explicit)

If a function/component/route touches any of:

- auth (NextAuth session, tokens, cookies, headers)
- gating (invite gating, temp-user support, access gating)
- permissions (owner/admin/member checks, doc/project/org access)
- security-sensitive data (emails, share passwords, secrets, Stripe webhooks)

…the JSDoc **must** include a `Security:` section documenting:

- **Who** is allowed (and by what check)
- **What is blocked** (and failure behavior)
- **Threat-sensitive assumptions** (e.g. “never trust redirect”, “webhook-driven access”, “cookie is httpOnly”, “signature verified”)

### Internal “non-trivial” functions must be commented

Any non-exported helper that is non-trivial must have a short comment describing **why it exists**.

**Non-trivial** means any helper that:

- has branching logic (multiple early returns / condition trees)
- handles edge cases or error mapping
- performs parsing/validation/normalization
- performs caching, retry, idempotency, rate limiting
- contains security/auth/gating logic (always non-trivial)

**Exception**: obvious one-liners like `const isFoo = x === "foo"` do not need comments.

## Route handler documentation (required in file)

For `src/app/**` pages and API routes, keep the existing repo rule: add a short **top-of-file comment** describing **purpose and route**.

Additionally, each exported method handler (`GET`, `POST`, etc.) must have JSDoc describing:

- **Route** and method
- **Auth** requirements / actor resolution
- **Permission** checks (owner/admin/etc)
- **Caching** behavior (`no-store`, public caching, revalidate)
- **Side effects** (DB writes, blob writes, email, Stripe calls)
- **Idempotency** keys/guards when present

## “Bad vs good” examples

### Exported utility

Bad:

```ts
export function buildPublicShareUrl(shareId: string) {
  return `/s/${shareId}`;
}
```

Good:

```ts
/** Build a public recipient URL for a shared doc (does not validate existence). */
export function buildPublicShareUrl(shareId: string) {
  return `/s/${shareId}`;
}
```

### Security-sensitive route handler

Bad:

```ts
export async function POST(req: Request) {
  // ... verify signature, mutate billing state ...
}
```

Good:

```ts
/**
 * POST /api/stripe/webhook
 *
 * Security:
 * - Signature verified against the Stripe webhook secret.
 * - Access/billing is webhook-driven; redirects are never trusted.
 *
 * Side effects: writes billing/subscription state to MongoDB.
 */
export async function POST(req: Request) {
  // ...
}
```

### Non-trivial internal helper

Bad:

```ts
function normalizeInviteCode(code: string) {
  return code.trim().toLowerCase().replace(/-/g, "");
}
```

Good:

```ts
// Normalize invite codes to a canonical format so we can dedupe requests and avoid “looks the same” bugs.
function normalizeInviteCode(code: string) {
  return code.trim().toLowerCase().replace(/-/g, "");
}
```

## Extraction rules (prevent duplication)

These rules exist to keep logic/UI/data access patterns from drifting across routes and features.

### When to extract a reusable React component

Extract a component when any is true:

- **Used in 2+ files** (not counting tests) → extract
- **15+ lines of repeated JSX** with the same structure → extract
- **Same UI pattern with different data** (cards, empty states, headers, dialogs) → extract
- **Reusable UI + props** (even if currently used once) when it’s clearly a pattern used elsewhere (e.g. “Card shell”, “Empty state”, “Pagination footer”)

**Component definition**: UI + props. Avoid hidden data fetching inside reusable components unless explicitly intended.

### When to extract a custom hook

Extract a hook when:

- **Repeated stateful logic** appears in 2+ places (effects, subscriptions, keyboard shortcuts, scroll syncing, async flows)
- The logic **touches side effects** (events, timers, network, localStorage, observers) → hook
- The logic needs **cleanup** (`return () => ...`) → hook
- There’s a repeated **async flow** with loading/error/cancel/retry handling → hook

**Hook definition**: side effects + state orchestration. Keep return values explicit and typed.

### When to extract a shared library / util module

Extract pure utilities when:

- Repeated formatting/parsing/validation shows up in 2+ places
- A domain concept needs a canonical implementation (IDs, slugs, cycle keys, cost/credits math)
- There’s a single “right way” to do something (e.g. URL builders, money formatting, date formatting, error normalization)

**Library definition**: pure logic, no React. Prefer deterministic functions with unit tests when easy.

### Data access patterns (avoid drift)

If you see repeated:

- request building (`fetch`, headers, error mapping)
- query/mutation shaping and response typing
- pagination/cursor patterns

…extract into a shared module so callers do not re-implement “API glue” differently.

## Where things live (repo conventions)

- **UI components**: `src/components/**`
  - If it’s route-specific, keep it next to the route as `pageClient.tsx`/`*Client.tsx` (but extract once it’s used elsewhere).
- **Hooks**: `src/hooks/**`
  - Hooks coupled to a specific domain library may live under that domain (`src/lib/<domain>/...`) only when they are inseparable.
- **Shared libraries**: `src/lib/**` (preferred)
  - Organize by domain: `auth`, `billing`, `credits`, `gating`, `http`, `format`, `models`, etc.
- **Utils**: do **not** create `src/utils` unless it becomes meaningfully distinct from `src/lib`.

## Automation & guardrails

### ESLint guardrails (current)

- Warn on missing JSDoc for exported functions/classes/arrow-function exports.
- Keep warnings as warnings (do not block iteration).

### PR checklist (recommended)

If you changed code that adds/changes exports, routes, or user-facing behavior, include the relevant checklist items from the PR template.

### Cursor/agent behavior (required)

- Start with `INDEX.md` + `docs/FEATURES.md` to understand intent and surface area.
- Do not add “nice to have” refactors unless explicitly requested.
- If you add/move/rename a file or change exported APIs, update `INDEX.md` in the same change (no exceptions).
- If you change user-facing behavior, update `docs/FEATURES.md` in the same change.

