/**
 * Every template now sends multipart, and these are the ways that goes wrong quietly.
 *
 * The failure worth guarding is **drift between the two bodies**. A template that writes its own
 * markup will eventually put a link in the HTML and forget the text part, and nobody notices,
 * because almost every client shows the HTML — until one doesn't, and the mail is unusable with no
 * error anywhere. Blocks make that structurally hard; this proves it stayed hard.
 *
 * The second is escaping. Document titles, workspace names and reader-supplied names all reach
 * these bodies, and they are attacker-influenced: a reader types their own name. An unescaped `<`
 * in an HTML mail is not just broken layout, it is markup injected into something a person opens.
 */
import { describe, expect, test } from "vitest";

import { buildPreviews } from "@/lib/email/previews";
import { renderHtml, renderText, type Block } from "@/lib/email/layout";
import { EMAIL_CATALOG } from "@/lib/email/templates";
import { welcomeEmail } from "@/lib/email/templates/welcome";
import { viewerIntroducedEmail } from "@/lib/email/templates/viewerIntroduction";
import { downloadRequestOwnerEmail } from "@/lib/email/templates/downloadRequest";

const rows = buildPreviews();

/** Every `href` the HTML body links to. */
function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
}

function decode(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

describe("every email has both bodies", () => {
  test("no previewable template is text-only", () => {
    const missing = rows.filter((r) => !r.html).map((r) => r.key);
    expect(missing, "templates that would send as plain text").toEqual([]);
  });

  test("each is a complete document that cannot be inverted by a dark-mode client", () => {
    for (const r of rows) {
      expect(r.html, r.key).toMatch(/^<!doctype html>/);
      // Without this, Gmail and Outlook dark modes recolour the card and the greys become unreadable.
      expect(r.html, r.key).toContain('name="color-scheme" content="light only"');
      expect(r.html, r.key).toContain("</html>");
    }
  });

  test("every link in the HTML is also reachable from the plain-text part", () => {
    for (const r of rows) {
      for (const href of hrefs(r.html ?? "")) {
        const url = decode(href);
        if (!url || url.startsWith("mailto:")) continue;
        expect(r.text, `${r.key} links ${url} in HTML only`).toContain(url);
      }
    }
  });

  test("the catalogue and the previews agree about what exists", () => {
    const previewed = new Set(rows.map((r) => r.catalogId));
    const known = new Set(EMAIL_CATALOG.map((r) => r.id));
    for (const id of previewed) expect(known.has(id), `${id} is previewed but not in EMAIL_CATALOG`).toBe(true);
  });
});

describe("escaping", () => {
  test("a reader-supplied name cannot inject markup", () => {
    const mail = viewerIntroducedEmail({
      documentTitle: '<script>alert(1)</script>',
      viewerName: '"><b>Dana',
      viewerEmail: "dana@example.com",
      verified: false,
    });
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).not.toContain("<b>Dana");
    expect(mail.html).toContain("&lt;script&gt;");
    // The text part keeps the raw characters; there is nothing to escape into.
    expect(mail.text).toContain("<script>");
  });

  test("a URL with an ampersand survives into a usable href", () => {
    const url = "https://lnkdrp.com/approve?a=1&b=2";
    const mail = downloadRequestOwnerEmail({
      title: "Deck",
      shareUrl: "",
      requesterEmail: "d@x.com",
      approveUrl: url,
      denyUrl: "",
    });
    expect(mail.html).toContain('href="https://lnkdrp.com/approve?a=1&amp;b=2"');
    expect(mail.text).toContain(url);
  });
});

describe("blocks", () => {
  test("a secondary action is visually distinct from a primary one", () => {
    const primary = renderHtml({ subject: "s", blocks: [{ kind: "action", label: "Go", url: "https://x.test" }] });
    const secondary = renderHtml({
      subject: "s",
      blocks: [{ kind: "action", label: "Go", url: "https://x.test", variant: "secondary" }],
    });
    expect(primary).not.toBe(secondary);
    expect(primary).toContain("#18181b");
    expect(secondary).toContain("border:1px solid");
  });

  test("the text renderer keeps a button's URL, which is the whole point of the fallback", () => {
    const text = renderText([{ kind: "action", label: "Open", url: "https://x.test/go" }]);
    expect(text).toContain("Open: https://x.test/go");
  });

  test("a transactional footer carries the signature and offers no unsubscribe it cannot honour", () => {
    const mail = welcomeEmail({ name: "Dana", appUrl: "https://lnkdrp.com" });
    expect(mail.text.trimEnd().endsWith("- LinkDrop")).toBe(true);
    expect(mail.html).toContain("- LinkDrop");
    expect(mail.html?.toLowerCase()).not.toContain("unsubscribe");
  });

  test("an empty rows block renders nothing rather than an empty table", () => {
    const blocks: Block[] = [{ kind: "rows", rows: [] }];
    expect(renderHtml({ subject: "s", blocks })).not.toContain("<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"margin:0 0 14px");
  });
});
