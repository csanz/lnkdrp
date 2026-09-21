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
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

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

describe("senders forward the whole message", () => {
  /**
   * The bug this pins actually shipped for an afternoon.
   *
   * Every sender read `const { subject, text } = someEmail(...)`, which was right while templates
   * were text-only. The day they grew an HTML part, eight of them kept taking two fields out of
   * three: the mail still sent, still read correctly, and simply arrived as plain text. No error,
   * no failing test, and the previews page looked perfect the whole time — because it calls the
   * template, not the sender.
   *
   * `sendEmailContent` takes the whole `EmailContent`, so a part added later travels on its own.
   * A new `const { subject, text } =` is the shape of the old bug coming back.
   */
  test("no sender destructures a template into subject and text alone", () => {
    const root = path.resolve(__dirname, "../..");
    const files = execSync("git ls-files 'src/**/*.ts' 'src/**/*.tsx'", { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    const offenders: string[] = [];
    for (const rel of files) {
      const src = fs.readFileSync(path.join(root, rel), "utf8");
      for (const line of src.split("\n")) {
        // Comments are allowed to quote the old shape while explaining why it was wrong.
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        const m = line.match(/const \{\s*subject,\s*text\s*\}\s*=\s*(\w+)\(/);
        if (m) offenders.push(`${rel}: const { subject, text } = ${m[1]}(`);
      }
    }
    expect(offenders, "use sendEmailContent, so an added part is not silently dropped").toEqual([]);
  });

  test("the header logo is a PNG on an absolute URL, and the wordmark survives a blocked image", () => {
    const html = rows[0].html ?? "";
    const src = html.match(/<img src="([^"]+)"/)?.[1] ?? "";
    expect(src).toMatch(/^https:\/\//);
    // Gmail does not render SVG in mail; the app's own logo is only an SVG, hence the raster copy.
    expect(src).toMatch(/\.png$/);
    expect(html).toContain("width=\"22\" height=\"22\"");
    // Most clients block remote images until the reader allows them; the name must not vanish.
    expect(html).toContain(">LinkDrop</td>");
  });

  test("the logo source stays in the repo, matching what was published", () => {
    const root = path.resolve(__dirname, "../..");
    const tracked = execSync("git ls-files public/email-logo.png", { cwd: root, encoding: "utf8" }).trim();
    expect(tracked, "keep the source of truth for what publish-email-logo.ts uploaded").toBe(
      "public/email-logo.png",
    );
  });

  test("the logo is not served from this app's own origin", () => {
    // An asset under /public only resolves after a deploy, so every email sent in between shows a
    // broken-image box. That shipped once; blob storage is live the moment it is uploaded.
    const src = (rows[0].html ?? "").match(/<img src="([^"]+)"/)?.[1] ?? "";
    expect(src).not.toMatch(/lnkdrp\.com/);
  });
});
