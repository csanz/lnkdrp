import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * Visit briefs summarise a viewer's reading with automated processing and email it to the sender
 * (docs/prds/lnkdrp-visit-briefs.md). The Privacy Policy must say so to the viewer (section 5), in
 * the AI section (6), and in the list of service emails (3). This fails when any of the three is
 * removed, so the behaviour and the promise cannot drift apart.
 */
const SRC = path.resolve(__dirname, "../../src");

function page(rel: string): string {
  return readFileSync(path.join(SRC, rel), "utf8").replace(/\s+/g, " ");
}

function section(source: string, heading: string): string {
  const at = source.indexOf(`>${heading}</h2>`);
  expect(at, `section "${heading}" not found`).toBeGreaterThan(-1);
  const start = source.lastIndexOf("<section>", at);
  const end = source.indexOf("</section>", at);
  return source.slice(start, end);
}

describe("visit briefs legal copy", () => {
  const privacy = page("app/privacy/page.tsx");

  test("section 5 tells viewers their visit may be summarised by automated processing, and what is sent", () => {
    const s5 = section(privacy, "5. If Someone Shared a Document With You");
    expect(s5).toContain("<strong>Visit briefs, effective September 23, 2026:</strong>");
    expect(s5).toMatch(/summarised by automated processing into a short written account of your visit/);
    expect(s5).toContain("No content you typed is sent to the AI provider");
  });

  test("section 6 describes the automatic brief and what it is written from", () => {
    const s6 = section(privacy, "6. AI Processing");
    expect(s6).toMatch(/a visit brief is generated automatically a few minutes after a viewer stops reading/);
    expect(s6).toContain("unless the workspace turns automatic briefs off");
  });

  test("section 3 lists visit briefs with the other activity emails, under the same off switch", () => {
    const s3 = section(privacy, "3. How We Use Your Information");
    const item = s3.match(/<li>Send service emails:[^<]*<\/li>/)?.[0] ?? "";
    expect(item).toContain("visit briefs, the written account of a viewer's visit, which follow the same rule");
  });
});
