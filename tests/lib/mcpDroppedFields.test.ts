/**
 * The dropped-field class, guarded at the mechanism rather than one field at a time.
 *
 * `mcp/src/api.ts` maps every REST response key by key. That is deliberate - it keeps the MCP's
 * shapes stable when a route changes - but it has one failure mode, and the same one has now
 * happened five separate times:
 *
 *   projectLinkTraffic   a document in a data room reported "nobody identified" while the feed
 *                        named two readers, because the whole section was dropped
 *   totalsAllTime        "has anyone read this?" answered "no" about a deck read last quarter
 *   downloadsEnabled     "downloads: 0" could not be told from "downloads were never switched on"
 *   graceActive/atLimit  a Free workspace inside its grace window was told to upgrade
 *   unchangedFromPrevious a byte-identical replacement was reported as a new version
 *
 * Every one of them was a route adding a field and the mapper not being told. None of them failed
 * a test, because a test that asserts the shape the mapper produces agrees with itself.
 *
 * So this file compares the two sides: the keys a route puts in its response literal against the
 * keys the mapper actually reads. A field added to a route now fails here until somebody either
 * maps it or writes it into IGNORED below with a reason. The point is the decision, not the
 * mapping - plenty of keys should not cross into the MCP - but it has to be a decision rather than
 * an oversight.
 *
 * The parse is deliberately shallow: it reads the top-level keys of one object literal and the
 * `x.y` reads inside one function. That is enough for the four mappers that have carried every
 * incident so far, and a shallow parse that is obviously incomplete is better than a clever one
 * that quietly stops matching.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

/**
 * Keys a route emits that the MCP deliberately does not carry, each with the reason it stays
 * behind. Adding a key here is a decision; leaving one out is what this file exists to catch.
 */
const IGNORED: Record<string, Record<string, string>> = {
  plan: {
    orgId: "the MCP already knows its workspace from whoami",
    isPersonalOrg: "whoami carries this; the plan snapshot has no second opinion",
    role: "the caller is always the key's own owner or admin",
    canManageLinks: "role-derived, and the MCP refuses on the server side anyway",
    canRevealPassword: "same; get_share_link_password answers forbidden itself",
    grace: "graceActive is the part an agent can act on; the dates are a UI concern",
    fraction: "a progress bar for the web app, not a fact a tool needs",
    upgradeUrl: "plan_limit errors carry it where it matters",
  },
};

/** Top-level keys of the object literal starting at `open`, braces and strings respected. */
function literalKeys(src: string, open: number): string[] {
  const keys: string[] = [];
  let depth = 0;
  let i = open;
  let atKey = false;
  for (; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < src.length && src[i] !== quote) i += src[i] === "\\" ? 2 : 1;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") {
      depth++;
      if (depth === 1) atKey = true;
      continue;
    }
    if (ch === "}" || ch === "]" || ch === ")") {
      depth--;
      if (depth === 0) break;
      continue;
    }
    if (depth === 1) {
      if (ch === ",") atKey = true;
      else if (ch === ":") atKey = false;
      else if (atKey && /[A-Za-z_]/.test(ch)) {
        const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
        if (m) {
          // `// comment` lines and spread elements are not keys.
          const before = src.slice(Math.max(0, i - 3), i);
          if (!before.includes("...") && !before.includes("//")) keys.push(m[0]);
          i += m[0].length - 1;
          atKey = false;
        }
      }
    }
  }
  return [...new Set(keys)];
}

/** Every `<base>.<key>` read inside `body`, which is how a mapper names what it takes. */
function readsOf(body: string, bases: string[]): Set<string> {
  const out = new Set<string>();
  for (const base of bases) {
    for (const m of body.matchAll(new RegExp(`\\b${base}\\.([A-Za-z_][A-Za-z0-9_]*)`, "g"))) out.add(m[1]!);
    // `rec(body.totals)` style: the key is named even when it is destructured afterwards.
    for (const m of body.matchAll(new RegExp(`\\b${base}\\["([A-Za-z0-9_]+)"\\]`, "g"))) out.add(m[1]!);
  }
  return out;
}

/**
 * The source of one method, sliced to the next sibling.
 *
 * Not brace-matched on purpose. `async getUpload(...): Promise<{ ... }> {` opens its first brace
 * inside the RETURN TYPE, so a matcher that takes "the first { after the signature" reads the type
 * and never sees the body - which is how the first version of this file concluded that getUpload
 * had stopped reading a field it reads on its own second line. Methods in this class sit at one
 * indent, so the next `\n  async ` is the boundary, and being slightly generous costs nothing here:
 * a read attributed to the wrong method still has to exist somewhere.
 */
function methodSource(src: string, name: string): string {
  const at = src.indexOf(`async ${name}(`);
  expect(at, `no method ${name} in mcp/src/api.ts`).toBeGreaterThan(-1);
  const next = src.indexOf("\n  async ", at + 1);
  return src.slice(at, next === -1 ? src.length : next);
}

/** Comments removed, so a key named in prose is not mistaken for a key in the literal. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("every field a route returns is either mapped into the MCP or deliberately left behind", () => {
  const API = read("mcp/src/api.ts");

  it("GET /api/plan: planSnapshot reads or refuses every key", () => {
    const route = stripComments(read("src/app/api/plan/route.ts"));
    /**
     * The success literal, found by what it contains rather than by where it sits.
     *
     * Taking the first `NextResponse.json(` in the file reads the 400 branch - a route answers its
     * guard clauses before its answer - so `emitted` was the single key `error` and every real
     * ignore below looked stale. The success response is the one carrying both `plan` and `limits`.
     */
    const emitted = (() => {
      for (let i = route.indexOf("NextResponse.json("); i !== -1; i = route.indexOf("NextResponse.json(", i + 1)) {
        const keys = literalKeys(route, route.indexOf("{", i));
        if (keys.includes("plan") && keys.includes("limits")) return keys;
      }
      throw new Error("could not find the plan route's success response");
    })();
    const taken = readsOf(methodSource(API, "planSnapshot"), ["p"]);
    const ignored = IGNORED.plan!;

    const unaccounted = emitted.filter((k) => !taken.has(k) && !(k in ignored));
    expect(
      unaccounted,
      `GET /api/plan returns these and planSnapshot neither reads nor ignores them. Map them in ` +
        `mcp/src/api.ts, or add each to IGNORED in this file with the reason it stays behind.`,
    ).toEqual([]);

    // The other direction: an ignore that no longer corresponds to anything the route sends is
    // stale, and a stale ignore is how a field slips back in unnoticed.
    const staleIgnores = Object.keys(ignored).filter((k) => !emitted.includes(k));
    expect(staleIgnores, "IGNORED.plan names keys GET /api/plan no longer returns").toEqual([]);
  });

  it("the mappers that carried the five incidents still read the fields those incidents were about", () => {
    // Pinned by name, because each of these cost a defect: if one is dropped again the test says
    // which, rather than leaving a reader to rediscover why the field matters.
    const shareViews = readsOf(methodSource(API, "shareViews"), ["body", "totals", "t"]);
    for (const field of ["projectLinkTraffic", "totalsAllTime", "downloadsEnabled", "lastViewedAt"]) {
      expect(shareViews.has(field), `shareViews stopped reading ${field}`).toBe(true);
    }
    const plan = readsOf(methodSource(API, "planSnapshot"), ["p"]);
    for (const field of ["graceActive", "atLimit"]) {
      expect(plan.has(field), `planSnapshot stopped reading ${field}`).toBe(true);
    }
    const upload = readsOf(methodSource(API, "getUpload"), ["u"]);
    expect(upload.has("unchangedFromPrevious"), "getUpload stopped reading unchangedFromPrevious").toBe(true);
  });
});
