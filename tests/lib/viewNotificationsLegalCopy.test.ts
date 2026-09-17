import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * View notification emails are on by default (PRD lnkdrp-view-notifications, decision 9). The Terms
 * and the Privacy Policy must say so, and must say it in the section each statement belongs to.
 * This fails when one of those statements is removed or drifts back to opt-in wording.
 */
const SRC = path.resolve(__dirname, "../../src");

/** Page source with whitespace collapsed, so wrapped JSX lines still match one sentence. */
function page(rel: string): string {
  return readFileSync(path.join(SRC, rel), "utf8").replace(/\s+/g, " ");
}

/** The source of one numbered `<section>`, found by its heading text. */
function section(source: string, heading: string): string {
  const at = source.indexOf(`>${heading}</h2>`);
  expect(at, `section "${heading}" not found`).toBeGreaterThan(-1);
  const start = source.lastIndexOf("<section>", at);
  const end = source.indexOf("</section>", at);
  return source.slice(start, end);
}

describe("view notifications legal copy", () => {
  const tos = page("app/tos/page.tsx");
  const privacy = page("app/privacy/page.tsx");

  test("Terms section 2 says view notifications are on by default and can be turned off per member", () => {
    const s2 = section(tos, "2. Description of Service");
    expect(s2).toContain(
      "are sent to workspace members by default and can be turned off per member from any such email or from settings.",
    );
    expect(s2).toMatch(/View notifications, which tell you that someone opened a document/);
  });

  test("Terms section 2 carries the dated change note", () => {
    const s2 = section(tos, "2. Description of Service");
    expect(s2).toContain("<strong>Notification change, effective September 16, 2026:</strong>");
    expect(s2).toContain("we now email workspace members when someone opens a document shared from their workspace.");
  });

  test("Privacy 'How we use' no longer calls activity emails opt-in", () => {
    const s3 = section(privacy, "3. How We Use Your Information");
    const item = s3.match(/<li>Send service emails:[^<]*<\/li>/)?.[0] ?? "";
    expect(item).not.toBe("");
    expect(item).toContain(
      "document activity notifications and digests, which are on by default and which you can turn off at any time in your settings (view notifications can also be turned off from the email itself);",
    );
    expect(item).not.toMatch(/opted into/i);
  });

  test("Privacy 'How we use' carries the dated change note", () => {
    const s3 = section(privacy, "3. How We Use Your Information");
    expect(s3).toContain("<strong>Notification change, effective September 16, 2026:</strong>");
    expect(s3).toContain("They are on by default");
  });

  test("Privacy section 5 tells viewers who may be emailed when they open the link and what it can contain", () => {
    const s5 = section(privacy, "5. If Someone Shared a Document With You");
    expect(s5).toContain("The document owner and members of their workspace may be emailed when you open it, and that email can include the details above that are shown to the owner.");
  });

  test("both pages show a last-updated date on or after the change", () => {
    const change = Date.UTC(2026, 8, 16);
    for (const [name, source] of [["tos", tos], ["privacy", privacy]] as const) {
      const raw = source.match(/const LAST_UPDATED = "([^"]+)";/)?.[1];
      expect(raw, `${name} LAST_UPDATED not found`).toBeTruthy();
      const parsed = new Date(`${raw} 00:00:00 UTC`).getTime();
      expect(Number.isNaN(parsed), `${name} LAST_UPDATED "${raw}" does not parse`).toBe(false);
      expect(parsed, `${name} LAST_UPDATED "${raw}" is before the change`).toBeGreaterThanOrEqual(change);
    }
  });
});
