/**
 * Who the mail says it is from.
 *
 * `INVITE_EMAIL_FROM` is a bare `hi@updates.lnkdrp.com`, and a bare address carries no display
 * name — so every client fell back to the local part and our mail arrived from a sender called
 * **hi**. The name is applied in `sendTextEmail` rather than in the environment variable because
 * there are three such variables across two deployments plus every developer's `.env.local`, and a
 * bare address in any one of them brings "hi" straight back.
 *
 * These drive the exported helper through the real code path by reading what the module would send.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const fetchMock = vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify({ id: "x" }), { status: 200 }));

function sentFrom(): string {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
  const body = JSON.parse(String(init?.body ?? "{}"));
  return body.from as string;
}

describe("from name", () => {
  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("EMAIL_TRANSPORT", "");
    vi.stubEnv("NOTIFICATION_EMAIL_FROM", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  test("a bare address gains the team name", async () => {
    vi.stubEnv("INVITE_EMAIL_FROM", "hi@updates.lnkdrp.com");
    const { sendTextEmail } = await import("@/lib/email/sendTextEmail");
    await sendTextEmail({ to: "a@b.lnkdrp.com", subject: "s", text: "t" });
    expect(sentFrom()).toBe("LinkDrop Team <hi@updates.lnkdrp.com>");
  });

  test("an address already carrying a name is left exactly as configured", async () => {
    vi.stubEnv("INVITE_EMAIL_FROM", "Support <help@lnkdrp.com>");
    const { sendTextEmail } = await import("@/lib/email/sendTextEmail");
    await sendTextEmail({ to: "a@b.lnkdrp.com", subject: "s", text: "t" });
    expect(sentFrom()).toBe("Support <help@lnkdrp.com>");
  });

  test("EMAIL_FROM_NAME overrides it", async () => {
    vi.stubEnv("INVITE_EMAIL_FROM", "hi@updates.lnkdrp.com");
    vi.stubEnv("EMAIL_FROM_NAME", "Acme Docs");
    const { sendTextEmail } = await import("@/lib/email/sendTextEmail");
    await sendTextEmail({ to: "a@b.lnkdrp.com", subject: "s", text: "t" });
    expect(sentFrom()).toBe("Acme Docs <hi@updates.lnkdrp.com>");
  });

  test("a name needing quotes gets them, rather than producing a malformed header", async () => {
    vi.stubEnv("INVITE_EMAIL_FROM", "hi@updates.lnkdrp.com");
    vi.stubEnv("EMAIL_FROM_NAME", "LinkDrop, Inc.");
    const { sendTextEmail } = await import("@/lib/email/sendTextEmail");
    await sendTextEmail({ to: "a@b.lnkdrp.com", subject: "s", text: "t" });
    // Unquoted, the comma would read as a second recipient.
    expect(sentFrom()).toBe('"LinkDrop, Inc." <hi@updates.lnkdrp.com>');
  });

  test("an explicit per-send from is named too", async () => {
    vi.stubEnv("INVITE_EMAIL_FROM", "hi@updates.lnkdrp.com");
    const { sendTextEmail } = await import("@/lib/email/sendTextEmail");
    await sendTextEmail({ to: "a@b.lnkdrp.com", subject: "s", text: "t", from: "invites@lnkdrp.com" });
    expect(sentFrom()).toBe("LinkDrop Team <invites@lnkdrp.com>");
  });
});
