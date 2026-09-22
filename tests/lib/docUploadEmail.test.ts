/**
 * "Someone added a document" — the newest email, and the one nothing was testing.
 *
 * `emailHtml.test.ts` already proves every previewable template has both bodies and escapes what
 * goes into them, which covers this one as far as the generic rules reach. What it cannot see is
 * what this builder decides: who gets named, what a missing page count does to the sentence, and
 * whether the one-document and many-document shapes stay different mails rather than converging on
 * a list of one.
 *
 * The two that would actually hurt:
 *
 * - **The unsubscribe has to be this kind's.** The header is what a client's one-click button
 *   posts to, and an off-token minted for view mail or doc-update mail switches off the wrong
 *   thing — a reader asking not to hear about new documents would silently lose their view
 *   notifications instead, and the mail they meant to stop would keep arriving.
 * - **A missing uploader must not leave a hole.** `uploadedBy` is null whenever the name cannot be
 *   resolved, and an empty string dropped into `X added "Deck"` produces a subject line that opens
 *   with a space and reads as a bug in the product.
 */
import { describe, expect, test } from "vitest";

import { composeDocUploadEmail, docUploadSubject, type DocUploadEntry } from "@/lib/notifications/docUploadEmail";

const OFF_URL = "https://app.lnkdrp.com/api/notifications/views/off?k=doc_uploads&t=tok";
const PREFS_URL = "https://app.lnkdrp.com/settings/notifications";

function entry(over: Partial<DocUploadEntry> = {}): DocUploadEntry {
  return {
    title: "Series A Deck",
    uploadedBy: "Dana Whitfield",
    pages: 14,
    url: "https://app.lnkdrp.com/doc/68c1f0a2b3c4d5e6f7a80001",
    ...over,
  };
}

function compose(entries: readonly DocUploadEntry[], daily = false) {
  return composeDocUploadEmail({
    entries,
    daily,
    workspace: { name: "Northwind", avatarUrl: null },
    offUrl: OFF_URL,
    preferencesUrl: PREFS_URL,
    turnOffLabel: "Turn these off",
    changeHowOftenLabel: "Change how often",
  });
}

describe("the subject", () => {
  test("names the person and the document when there is one of each", () => {
    expect(docUploadSubject([entry()], false)).toBe('Dana Whitfield added "Series A Deck"');
  });

  test("counts instead of naming when several arrived at once", () => {
    expect(docUploadSubject([entry(), entry({ title: "Cap Table" })], false)).toBe("2 documents were added");
  });

  test("a digest counts documents, and gets the plural right at one", () => {
    expect(docUploadSubject([entry()], true)).toBe("1 new document");
    expect(docUploadSubject([entry(), entry()], true)).toBe("2 new documents");
  });

  test("falls back to Someone rather than opening with a space", () => {
    for (const uploadedBy of [null, "", "   "]) {
      expect(docUploadSubject([entry({ uploadedBy })], false)).toBe('Someone added "Series A Deck"');
    }
  });
});

describe("one document", () => {
  test("states the title and the page count, and offers the document itself", () => {
    const mail = compose([entry()]);
    expect(mail.text).toContain("Dana Whitfield added a document");
    expect(mail.text).toContain("Document: Series A Deck");
    expect(mail.text).toContain("Pages: 14");
    expect(mail.text).toContain("Open the document: https://app.lnkdrp.com/doc/68c1f0a2b3c4d5e6f7a80001");
  });

  test("says nothing about pages when the count is unknown or zero", () => {
    // A processing failure leaves it null, and "Pages: 0" would be a claim about the file.
    for (const pages of [null, 0]) {
      const mail = compose([entry({ pages })]);
      expect(mail.text, String(pages)).not.toContain("Pages:");
      expect(mail.html, String(pages)).not.toContain("Pages");
    }
  });
});

describe("several documents", () => {
  test("gives each its own link with who added it underneath, rather than one list twice", () => {
    const mail = compose([
      entry({ title: "Series A Deck", uploadedBy: "Dana Whitfield", pages: 14, url: "https://app.lnkdrp.com/doc/a" }),
      entry({ title: "Cap Table", uploadedBy: null, pages: null, url: "https://app.lnkdrp.com/doc/b" }),
    ]);

    expect(mail.text).toContain("Series A Deck: https://app.lnkdrp.com/doc/a");
    expect(mail.text).toContain("Dana Whitfield · 14 pages");
    expect(mail.text).toContain("Cap Table: https://app.lnkdrp.com/doc/b");
    // No page count to give, so the line is the name alone — not a dangling separator.
    expect(mail.text).toContain("Someone");
    expect(mail.text).not.toContain("Someone · ");
    // Each title appears once as a link, not once as text and again as a link.
    expect(mail.text.match(/Series A Deck/g)).toHaveLength(1);
  });

  test("does not offer a single 'Open the document' button for a set of them", () => {
    const mail = compose([entry({ url: "https://app.lnkdrp.com/doc/a" }), entry({ url: "https://app.lnkdrp.com/doc/b" })]);
    expect(mail.text).not.toContain("Open the document");
  });
});

describe("the way out", () => {
  test("the one-click headers carry this kind's off link, not another kind's", () => {
    const mail = compose([entry()]);
    expect(mail.headers["List-Unsubscribe"]).toBe(`<${OFF_URL}>`);
    expect(mail.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(mail.headers["List-Unsubscribe"]).toContain("k=doc_uploads");
  });

  test("both bodies offer the same two ways out as the header does", () => {
    const mail = compose([entry()]);
    for (const body of [mail.text, mail.html]) {
      expect(body).toContain("Turn these off");
      expect(body).toContain("Change how often");
      expect(body).toContain(PREFS_URL);
    }
    // The HTML escapes the query separator; the text part cannot.
    expect(mail.text).toContain(OFF_URL);
    expect(mail.html).toContain(OFF_URL.replace(/&/g, "&amp;"));
  });

  test("says which workspace it is about, and stays a sentence when there is no name", () => {
    expect(compose([entry()]).text).toContain("someone added a document to Northwind.");
    const anonymous = composeDocUploadEmail({
      entries: [entry()],
      daily: false,
      workspace: null,
      offUrl: OFF_URL,
      preferencesUrl: PREFS_URL,
      turnOffLabel: "Turn these off",
      changeHowOftenLabel: "Change how often",
    });
    expect(anonymous.text).toContain("someone added a document to your workspace.");
  });
});

describe("what a reader can put in it", () => {
  test("a title or a name carrying markup is escaped in the HTML part", () => {
    // Titles come from a filename and names from a profile; neither is ours to trust.
    const mail = compose([entry({ title: '<img src=x onerror=alert(1)>', uploadedBy: '<b>Dana</b>' })]);
    expect(mail.html).not.toContain("<img src=x");
    expect(mail.html).not.toContain("<b>Dana</b>");
    expect(mail.html).toContain("&lt;img src=x");
    // The text part is text: it carries the characters as typed, and that is correct.
    expect(mail.text).toContain("<img src=x onerror=alert(1)>");
  });
});
