import { describe, expect, test } from "vitest";

import {
  EMAIL_CATALOG,
  downloadRequestApprovedEmail,
  downloadRequestOwnerEmail,
  downloadRequestReceivedEmail,
  memberRemovedEmail,
  viewerIntroducedEmail,
  viewerVerifyEmail,
} from "@/lib/email/templates";

/**
 * Email bodies live in `src/lib/email/templates` so they can be read and tested without the route
 * that sends them. These cover the download-request trio, including the missing-site-URL fallbacks
 * the owner mail used to inline.
 */
/**
 * The last line of every email, from `layout.ts`.
 *
 * These three used to assert the body ended with the sign-off. It ends with the postal address
 * now; the sign-off is still there, one line above.
 */
const POSTAL_ADDRESS = "455 Market St Ste 1940 #695619, San Francisco, California 94105";

describe("download request emails", () => {
  test("receipt names the document and the link", () => {
    const mail = downloadRequestReceivedEmail({ title: "Series A deck", shareUrl: "https://lnkdrp.com/s/abc" });
    expect(mail.subject).toBe("Request received: Series A deck");
    expect(mail.text).toContain("Document: Series A deck");
    expect(mail.text).toContain("Link: https://lnkdrp.com/s/abc");
    expect(mail.text.trimEnd()).toContain("- LinkDrop");
    expect(mail.text.trimEnd().endsWith(POSTAL_ADDRESS)).toBe(true);
  });

  test("owner mail carries who asked, approve and deny", () => {
    const mail = downloadRequestOwnerEmail({
      title: "Series A deck",
      shareUrl: "https://lnkdrp.com/s/abc",
      requesterEmail: "jeff@example.com",
      approveUrl: "https://lnkdrp.com/approve",
      denyUrl: "https://lnkdrp.com/deny",
    });
    expect(mail.subject).toBe("Download request: Series A deck");
    expect(mail.text).toContain("Requester email: jeff@example.com");
    expect(mail.text).toContain("Approve: https://lnkdrp.com/approve");
    expect(mail.text).toContain("Deny: https://lnkdrp.com/deny");
  });

  test("a missing site URL says so instead of sending an empty link", () => {
    const mail = downloadRequestOwnerEmail({ title: "", shareUrl: "", requesterEmail: "j@x.com", approveUrl: "", denyUrl: "" });
    expect(mail.subject).toBe("Download request: Shared document");
    expect(mail.text).toContain("Approve: (missing NEXT_PUBLIC_SITE_URL)");
    expect(mail.text).not.toContain("Share link:");
  });

  test("approval mail carries the claim link and the sign-in note", () => {
    const mail = downloadRequestApprovedEmail({ title: "Series A deck", claimUrl: "https://lnkdrp.com/download/t" });
    expect(mail.subject).toBe("Download approved: Series A deck");
    expect(mail.text).toContain("Open to download or save: https://lnkdrp.com/download/t");
    expect(mail.text).toContain("sign in");
  });

  test("the catalog lists every email, with where its body is built", () => {
    expect(EMAIL_CATALOG.length).toBeGreaterThanOrEqual(11);
    for (const row of EMAIL_CATALOG) {
      expect(row.id, row.id).toMatch(/^[a-z_]+(\.[a-z_]+)?$/);
      expect(row.builtBy, row.id).toMatch(/\.ts$/);
    }
  });
});

/**
 * The removal notice. Short by design, so what is pinned here is the part that has to be right:
 * the workspace is named, the "nothing of yours left with you" sentence is present, and the link
 * comes from the caller rather than an env var nothing sets — which is how it went missing once.
 */
describe("member removed email", () => {
  test("names the workspace, who did it, and what stays behind", () => {
    const mail = memberRemovedEmail({
      orgName: "USAVX",
      removedByEmail: "owner@example.com",
      appUrl: "https://lnkdrp.com/",
    });
    expect(mail.subject).toBe("You were removed from USAVX");
    // The workspace is named in the opening line; the sentence under it does not repeat it.
    expect(mail.text).toContain("You were removed from USAVX");
    expect(mail.text).toContain("You no longer have access to that workspace.");
    expect(mail.text).toContain("Removed by: owner@example.com");
    expect(mail.text).toContain("Anything you uploaded stays with the workspace");
    // The trailing slash is trimmed rather than doubled into the URL.
    expect(mail.text).toContain("Your workspace: https://lnkdrp.com\n");
    expect(mail.text.trimEnd()).toContain("- LinkDrop");
    expect(mail.text.trimEnd().endsWith(POSTAL_ADDRESS)).toBe(true);
  });

  test("an unnamed workspace and an unknown remover still read as a sentence", () => {
    const mail = memberRemovedEmail({ orgName: "  ", appUrl: "" });
    expect(mail.subject).toBe("You were removed from a workspace");
    expect(mail.text).not.toContain("Removed by:");
    expect(mail.text).not.toContain("Your workspace:");
  });
});

/**
 * The reader's confirmation mail and the owner's correction. What is pinned here is the promise
 * the intro form makes and the distinction the owner acts on: the reader's mail must never read
 * like a wall in front of a document they are already looking at, and the owner's must say plainly
 * whether an address was confirmed or merely typed.
 */
describe("viewer introduction emails", () => {
  test("the reader's mail says the document stays open", () => {
    const mail = viewerVerifyEmail({
      documentTitle: "Series A deck",
      workspaceName: "Acme",
      verifyUrl: "https://lnkdrp.com/share/verify?t=tok",
    });
    expect(mail.subject).toBe('Confirm your email for "Series A deck"');
    expect(mail.text).toContain('reading "Series A deck" from Acme');
    expect(mail.text).toContain("https://lnkdrp.com/share/verify?t=tok");
    expect(mail.text).toContain("The document stays open either way");
    expect(mail.text.trimEnd()).toContain("- LinkDrop");
    expect(mail.text.trimEnd().endsWith(POSTAL_ADDRESS)).toBe(true);
  });

  test("an untitled document and a nameless workspace still read as a sentence", () => {
    const mail = viewerVerifyEmail({ documentTitle: "  ", workspaceName: null, verifyUrl: "https://x/y" });
    expect(mail.subject).toBe("Confirm your email");
    expect(mail.text).toContain("reading a document.");
    expect(mail.text).not.toContain("from ");
  });

  test("the owner's mail distinguishes a confirmed address from a claimed one", () => {
    const confirmed = viewerIntroducedEmail({
      documentTitle: "Series A deck",
      viewerName: "Dana Lee",
      viewerEmail: "dana@example.com",
      verified: true,
      metricsUrl: "https://lnkdrp.com/doc/abc/metrics",
    });
    expect(confirmed.subject).toBe('Dana Lee introduced themselves on "Series A deck"');
    expect(confirmed.text).toContain("Dana Lee (dana@example.com)");
    expect(confirmed.text).toContain("so it is theirs");
    expect(confirmed.text).toContain("What they read: https://lnkdrp.com/doc/abc/metrics");

    const claimed = viewerIntroducedEmail({
      documentTitle: "Series A deck",
      viewerEmail: "dana@example.com",
      verified: false,
    });
    expect(claimed.subject).toBe('A reader introduced themselves on "Series A deck"');
    expect(claimed.text).toContain("treat it as their claim rather than a fact");
    expect(claimed.text).not.toContain("What they read:");
  });
});
