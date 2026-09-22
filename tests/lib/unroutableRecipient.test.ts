/**
 * Addresses the mailer refuses, and the bounce that made the rule.
 *
 * Four sends to seeded `@*.example` recipients were accepted by Resend and hard-bounced against
 * `updates.lnkdrp.com` on the day its DMARC record went up. The addresses were never deliverable —
 * RFC 2606 reserves `.example` so that it cannot resolve — so the only fix that actually removes the
 * bounce is not sending. That is what `sendTextEmail` does now, and these are the rules it uses.
 *
 * The half worth guarding hardest is the last one: a refusal must not look like a failure. A queue
 * row that treats "this address cannot receive" as a retryable error would retry it forever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { recipientDomain, unroutableRecipientReason } from "@/lib/email/unroutableRecipient";
import { sendTextEmail } from "@/lib/email/sendTextEmail";

describe("which addresses cannot receive", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.EMAIL_BLOCKED_RECIPIENT_DOMAINS;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("refuses the four reserved TLDs, whatever is in front of them", () => {
    for (const to of ["philippe@accel.example", "a@b.test", "x@thing.invalid", "root@box.localhost"]) {
      expect(unroutableRecipientReason(to), to).toBe("reserved_tld");
    }
  });

  it("refuses a reserved TLD used bare, with no second level at all", () => {
    expect(unroutableRecipientReason("someone@localhost")).toBe("reserved_tld");
  });

  it("refuses the reserved second-level names too", () => {
    for (const to of ["owner@example.com", "owner@example.net", "owner@example.org"]) {
      expect(unroutableRecipientReason(to), to).toBe("reserved_domain");
    }
    // Only those three. A real company whose name merely starts the same way must still get mail.
    expect(unroutableRecipientReason("hi@examples.com")).toBeNull();
    expect(unroutableRecipientReason("hi@example.com.br")).toBeNull();
  });

  it("lets an ordinary address through", () => {
    for (const to of ["owner@lnkdrp.com", "a.b+tag@gmail.com", "x@sub.domain.co.uk"]) {
      expect(unroutableRecipientReason(to), to).toBeNull();
    }
  });

  it("refuses anything with no domain to read, rather than passing it to the provider", () => {
    for (const to of ["", "   ", "not-an-address", "@", "trailing@"]) {
      expect(unroutableRecipientReason(to), JSON.stringify(to)).not.toBeNull();
    }
  });

  it("is not fooled by case, a trailing root dot, or a display name around the address", () => {
    expect(unroutableRecipientReason("A@B.EXAMPLE")).toBe("reserved_tld");
    expect(unroutableRecipientReason("a@b.example.")).toBe("reserved_tld");
    expect(unroutableRecipientReason('"Philippe" <philippe@accel.example>')).toBe("reserved_tld");
    // An @ inside the display name does not become the domain: the last one wins.
    expect(recipientDomain('"a@b.example" <real@lnkdrp.com>')).toBe("lnkdrp.com");
  });

  describe("EMAIL_BLOCKED_RECIPIENT_DOMAINS", () => {
    it("blocks what a deployment declares a sink, and its subdomains with it", () => {
      process.env.EMAIL_BLOCKED_RECIPIENT_DOMAINS = "seed.lnkdrp.com, loadtest.io";
      expect(unroutableRecipientReason("a@seed.lnkdrp.com")).toBe("blocked_domain");
      expect(unroutableRecipientReason("a@eu.seed.lnkdrp.com")).toBe("blocked_domain");
      expect(unroutableRecipientReason("a@loadtest.io")).toBe("blocked_domain");
      // The parent is not blocked by a child being blocked.
      expect(unroutableRecipientReason("owner@lnkdrp.com")).toBeNull();
      // Nor is a domain that merely ends with the same letters.
      expect(unroutableRecipientReason("a@notseed.lnkdrp.com")).toBeNull();
    });

    it("is read per call, so a deployment can change it without a restart of this module", () => {
      expect(unroutableRecipientReason("a@sink.io")).toBeNull();
      process.env.EMAIL_BLOCKED_RECIPIENT_DOMAINS = "sink.io";
      expect(unroutableRecipientReason("a@sink.io")).toBe("blocked_domain");
    });
  });
});

describe("sendTextEmail refuses them", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    delete process.env.EMAIL_TRANSPORT;
    delete process.env.EMAIL_BLOCKED_RECIPIENT_DOMAINS;
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.NOTIFICATION_EMAIL_FROM = "notify@updates.lnkdrp.com";
  });

  afterEach(() => {
    process.env = { ...saved };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not call the provider at all for a reserved recipient — the bounce never happens", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendTextEmail({ to: "philippe@accel.example", subject: "Daily digest", text: "body" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves rather than throwing, so a queue row is done instead of retried forever", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));

    await expect(sendTextEmail({ to: "a@b.test", subject: "Daily digest", text: "body" })).resolves.toBeUndefined();
  });

  it("says why, with the domain but never the address or the body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await sendTextEmail({
      to: "philippe@accel.example",
      subject: 'Download request: "Series A Deck"',
      text: "private body",
    });

    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls[0]);
    expect(logged).toContain("reserved_tld");
    expect(logged).toContain("accel.example");
    expect(logged).not.toContain("philippe@");
    expect(logged).not.toContain("private body");
    expect(logged).not.toContain("Series A Deck");
  });

  it("still prints the copy under EMAIL_TRANSPORT=console: reviewing a seeded mail is the point", async () => {
    process.env.EMAIL_TRANSPORT = "console";
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await sendTextEmail({ to: "a@b.test", subject: "Daily digest", text: "body" });

    expect(log).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still sends to an ordinary recipient", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "em_1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendTextEmail({ to: "owner@lnkdrp.com", subject: "Daily digest", text: "body" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
