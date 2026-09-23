/**
 * The sender's postal address, on every email.
 *
 * CAN-SPAM requires it on *commercial* mail. Most of what this product sends is relationship mail —
 * "someone opened your document" — which is exempt, so this is not strictly owed today. It goes on
 * everything anyway, and that is the point worth testing: the alternative is judging per template
 * whether that template is commercial, forever, and getting it wrong the first time a digest reads
 * like an ad. Doing it in `layout.ts` means a template added next year cannot forget.
 *
 * So the test that matters is not "the welcome email has an address" but "no previewable template
 * is missing one" — a property over the whole catalogue, which a new template joins automatically.
 */
import { afterEach, describe, expect, test } from "vitest";

import { buildPreviews } from "@/lib/email/previews";
import { renderHtml, renderText, type Block } from "@/lib/email/layout";

const ADDRESS = "455 Market St Ste 1940 #695619, San Francisco, California 94105";

const BLOCKS: Block[] = [{ kind: "p", text: "Something happened." }];

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("every email carries it", () => {
  test("no previewable template is missing the address, in either body", () => {
    const rows = buildPreviews();
    expect(rows.length).toBeGreaterThan(0);
    const missingText = rows.filter((r) => !r.text?.includes(ADDRESS)).map((r) => r.key);
    const missingHtml = rows.filter((r) => r.html && !r.html.includes(ADDRESS)).map((r) => r.key);
    expect(missingText, "templates whose text part has no postal address").toEqual([]);
    expect(missingHtml, "templates whose HTML part has no postal address").toEqual([]);
  });

  test("it is the last line of the text part, below the sign-off or the unsubscribe links", () => {
    for (const r of buildPreviews()) {
      expect(r.text?.trimEnd().endsWith(ADDRESS), r.key).toBe(true);
    }
  });
});

describe("the three footer shapes", () => {
  test("a notice footer keeps its reason and links, and the address goes under them", () => {
    const text = renderText(BLOCKS, {
      reason: "You get this because someone opened a link.",
      links: [{ label: "Turn these off", url: "https://app.lnkdrp.com/off" }],
    });
    expect(text).toContain("You get this because someone opened a link.");
    expect(text).toContain("Turn these off: https://app.lnkdrp.com/off");
    expect(text.trimEnd().endsWith(ADDRESS)).toBe(true);
  });

  test("a transactional footer keeps its sign-off, with the address below it", () => {
    const text = renderText(BLOCKS, { signature: "- LinkDrop" }).trimEnd();
    expect(text).toContain("- LinkDrop");
    expect(text.indexOf("- LinkDrop")).toBeLessThan(text.indexOf(ADDRESS));
    expect(text.endsWith(ADDRESS)).toBe(true);
  });

  test("a body with no footer at all still gets one", () => {
    // The template most likely to be a mail-out is the one that says nothing about why it arrived.
    const text = renderText(BLOCKS).trimEnd();
    expect(text.endsWith(ADDRESS)).toBe(true);
    const html = renderHtml({ subject: "s", blocks: BLOCKS });
    expect(html).toContain(ADDRESS);
  });

  test("it brings no link with it, so a transactional mail still offers no unsubscribe", () => {
    const html = renderHtml({ subject: "s", blocks: BLOCKS, footer: { signature: "- LinkDrop" } });
    expect(html.toLowerCase()).not.toContain("unsubscribe");
    // The address is text in the footer, not an anchor.
    expect(html).not.toMatch(/<a[^>]*>[^<]*455 Market/);
  });
});

describe("EMAIL_POSTAL_ADDRESS", () => {
  test("overrides the built-in one, for a deployment that sends as someone else", () => {
    process.env.EMAIL_POSTAL_ADDRESS = "1 Other Way, Dublin, Ireland";
    const text = renderText(BLOCKS, { signature: "- LinkDrop" }).trimEnd();
    expect(text.endsWith("1 Other Way, Dublin, Ireland")).toBe(true);
    expect(text).not.toContain(ADDRESS);
  });

  test("set but empty prints none — that is a deployment saying not to, not asking for the default", () => {
    process.env.EMAIL_POSTAL_ADDRESS = "";
    const text = renderText(BLOCKS, { signature: "- LinkDrop" }).trimEnd();
    expect(text).not.toContain("455 Market");
    expect(text.endsWith("- LinkDrop")).toBe(true);
    const html = renderHtml({ subject: "s", blocks: BLOCKS, footer: { signature: "- LinkDrop" } });
    expect(html).not.toContain("455 Market");
  });

  test("is read per render, not captured once, so a deployment's value is never a stale import", () => {
    process.env.EMAIL_POSTAL_ADDRESS = "First Value";
    expect(renderText(BLOCKS)).toContain("First Value");
    process.env.EMAIL_POSTAL_ADDRESS = "Second Value";
    expect(renderText(BLOCKS)).toContain("Second Value");
  });

  test("markup in a configured address is escaped in the HTML part", () => {
    process.env.EMAIL_POSTAL_ADDRESS = '<b>Acme</b> & Co, 1 Way';
    const html = renderHtml({ subject: "s", blocks: BLOCKS });
    expect(html).not.toContain("<b>Acme</b>");
    expect(html).toContain("&lt;b&gt;Acme&lt;/b&gt; &amp; Co, 1 Way");
  });

  test("the built-in default is a real, complete postal address", () => {
    // A street, a city, a state and a postcode: the four things that make it valid rather than
    // decorative. Pinned so a tidy-up cannot quietly shorten it into non-compliance.
    delete process.env.EMAIL_POSTAL_ADDRESS;
    const text = renderText(BLOCKS);
    expect(text).toContain("455 Market St");
    expect(text).toContain("San Francisco");
    expect(text).toContain("California");
    expect(text).toContain("94105");
  });
});
