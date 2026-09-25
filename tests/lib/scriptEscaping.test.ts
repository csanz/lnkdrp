/**
 * Embedding a value in an inline `<script>` is not the same problem as embedding it in JSON.
 *
 * Pinned because it was a live reflected XSS. `/org/switch` returns an HTML page (rather than a
 * redirect, so the Set-Cookie sticks reliably) and wrote `JSON.stringify(redirectTo)` into a
 * `window.location.replace(...)` call. `JSON.stringify` escapes quotes and backslashes and leaves
 * `<` and `/` alone, so a `returnTo` of `/</script><script>…</script>` — which passes
 * `safeReturnTo`, whose only rule is "starts with a single slash" — closed the element for the
 * HTML parser and everything after it ran as markup on this origin, in the victim's session.
 *
 * The test is written against the payload rather than the implementation: whatever the escaping
 * does internally, the output must not be able to terminate the element, and must still parse back
 * to the identical string.
 */
import { describe, expect, test } from "vitest";

import { jsonForScript } from "@/lib/http/jsonForScript";

/** What a browser's JS parser would hand back, once the element has been parsed as script. */
function asJsWouldSee(escaped: string): unknown {
  return JSON.parse(escaped.replace(/\\u003c/g, "<").replace(/\\u003e/g, ">").replace(/\\u0026/g, "&"));
}

describe("jsonForScript", () => {
  test("a payload that closes the script element cannot", () => {
    const payload = "/</script><script>alert(1)</script>";
    const escaped = jsonForScript(payload);
    expect(escaped).not.toContain("</script>");
    expect(escaped).not.toContain("<");
    // …and the value is unchanged as far as the program is concerned.
    expect(asJsWouldSee(escaped)).toBe(payload);
  });

  test("angle brackets and ampersands never survive literally", () => {
    for (const s of ["<", ">", "&", "<!--", "<![CDATA[", "</ScRiPt >"]) {
      const escaped = jsonForScript(s);
      expect(escaped).not.toMatch(/[<>&]/);
      expect(asJsWouldSee(escaped)).toBe(s);
    }
  });

  test("U+2028 and U+2029 are escaped — they are line terminators in JavaScript source", () => {
    const s = "a b c";
    const escaped = jsonForScript(s);
    expect(escaped).not.toContain(" ");
    expect(escaped).not.toContain(" ");
  });

  test("ordinary paths are untouched in meaning", () => {
    for (const s of ["/", "/dashboard?tab=billing", "/doc/64b0c0ffee0000000000a001/metrics"]) {
      expect(asJsWouldSee(jsonForScript(s))).toBe(s);
    }
  });
});
