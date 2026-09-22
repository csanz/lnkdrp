import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendTextEmail } from "@/lib/email/sendTextEmail";

/**
 * The recipients here are `@lnkdrp.com` rather than `@example.com` because `sendTextEmail` now
 * refuses reserved domains outright — see `unroutableRecipient.ts`. These tests are about what
 * reaches Resend, so they have to use an address that is allowed to reach it.
 */
describe("sendTextEmail html (C3)", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    delete process.env.EMAIL_TRANSPORT;
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.NOTIFICATION_EMAIL_FROM = "lnkdrp <notify@example.com>";
  });

  afterEach(() => {
    process.env = { ...saved };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubFetch() {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "em_1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function sentBody(fetchMock: ReturnType<typeof stubFetch>): Record<string, unknown> {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    return JSON.parse(String(init.body)) as Record<string, unknown>;
  }

  it("forwards html to Resend alongside text when given", async () => {
    const fetchMock = stubFetch();
    const html = '<p>Sequoia opened &quot;USAVX MEMO&quot;</p>';
    await sendTextEmail({ to: "owner@lnkdrp.com", subject: 'Sequoia opened "USAVX MEMO"', text: "plain", html });
    const body = sentBody(fetchMock);
    expect(body.text).toBe("plain");
    expect(body.html).toBe(html);
    expect(body.to).toEqual(["owner@lnkdrp.com"]);
    expect(body.from).toBe("lnkdrp <notify@example.com>");
  });

  it("omits html from the Resend body when not given (existing callers unchanged)", async () => {
    const fetchMock = stubFetch();
    await sendTextEmail({ to: "owner@lnkdrp.com", subject: "Daily digest", text: "plain" });
    const body = sentBody(fetchMock);
    expect(body).toEqual({ from: "lnkdrp <notify@example.com>", to: ["owner@lnkdrp.com"], subject: "Daily digest", text: "plain" });
    expect("html" in body).toBe(false);
  });

  it("omits html when it is an empty string", async () => {
    const fetchMock = stubFetch();
    await sendTextEmail({ to: "owner@lnkdrp.com", subject: "Daily digest", text: "plain", html: "" });
    expect("html" in sentBody(fetchMock)).toBe(false);
  });

  it("console transport prints text and html in full and never calls fetch", async () => {
    process.env.EMAIL_TRANSPORT = "console";
    const fetchMock = stubFetch();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const text = "Line one\n" + "x".repeat(5000);
    const html = "<table><tr><td>" + "y".repeat(5000) + "</td></tr></table>";
    await sendTextEmail({ to: "owner@lnkdrp.com", subject: "Someone opened", text, html });
    expect(fetchMock).not.toHaveBeenCalled();
    const printed = logSpy.mock.calls.map((c) => c.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")).join("\n");
    expect(printed).toContain(text);
    expect(printed).toContain(html);
    expect(printed).toContain("Someone opened");
  });

  it("console transport without html prints the text and no html section", async () => {
    process.env.EMAIL_TRANSPORT = "console";
    stubFetch();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await sendTextEmail({ to: "owner@lnkdrp.com", subject: "Daily digest", text: "just text" });
    const printed = logSpy.mock.calls.map((c) => c.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")).join("\n");
    expect(printed).toContain("just text");
    expect(printed).not.toContain("html:");
  });

  it("forwards headers to Resend when given (RFC 8058 one-click unsubscribe)", async () => {
    const fetchMock = stubFetch();
    const headers = {
      "List-Unsubscribe": "<https://lnkdrp.com/api/notifications/views/off?t=abc>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    };
    await sendTextEmail({ to: "owner@lnkdrp.com", subject: "Someone opened", text: "plain", html: "<p>x</p>", headers });
    expect(sentBody(fetchMock).headers).toEqual(headers);
  });

  it("omits headers when absent or empty", async () => {
    let fetchMock = stubFetch();
    await sendTextEmail({ to: "owner@lnkdrp.com", subject: "Daily digest", text: "plain" });
    expect("headers" in sentBody(fetchMock)).toBe(false);
    vi.unstubAllGlobals();
    fetchMock = stubFetch();
    await sendTextEmail({ to: "owner@lnkdrp.com", subject: "Daily digest", text: "plain", headers: {} });
    expect("headers" in sentBody(fetchMock)).toBe(false);
  });

  it("drops headers with a line break in the value or a malformed name", async () => {
    const fetchMock = stubFetch();
    await sendTextEmail({
      to: "owner@lnkdrp.com",
      subject: "Someone opened",
      text: "plain",
      headers: { "List-Unsubscribe": "<https://x.test>\r\nBcc: a@b.c", "Bad Name": "v", "X-Ok": "yes" },
    });
    expect(sentBody(fetchMock).headers).toEqual({ "X-Ok": "yes" });
  });

  it("console transport prints the headers and never calls fetch", async () => {
    process.env.EMAIL_TRANSPORT = "console";
    const fetchMock = stubFetch();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await sendTextEmail({
      to: "owner@lnkdrp.com",
      subject: "Someone opened",
      text: "plain",
      headers: { "List-Unsubscribe": "<https://x.test/off?t=1>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    const printed = logSpy.mock.calls.map((c) => c.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")).join("\n");
    expect(printed).toContain("<https://x.test/off?t=1>");
    expect(printed).toContain("List-Unsubscribe=One-Click");
  });

  it("keeps the redacted failure log: no recipient, body or html in it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ statusCode: 422, name: "validation_error", message: "bad owner@lnkdrp.com" }), { status: 422 }),
      ),
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      sendTextEmail({ to: "owner@lnkdrp.com", subject: 'Sequoia opened "Secret Deck"', text: "body text", html: "<p>secret html</p>" }),
    ).rejects.toThrow(/422/);
    expect(errSpy).toHaveBeenCalledTimes(1);
    const line = JSON.stringify(errSpy.mock.calls[0]);
    expect(line).toContain("validation_error");
    expect(line).not.toMatch(/owner@example\.com|Secret Deck|body text|secret html/);
  });
});
