import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { redactLogText } from "@/lib/errors/logger";
import { errorJson } from "@/lib/http/errorResponse";
import { sendTextEmail } from "@/lib/email/sendTextEmail";

describe("redactLogText", () => {
  it("keeps the message but strips emails, credentials, tokens and keys", () => {
    const out = redactLogText(
      'E11000 dup key { email: "ann@example.com" } mongodb+srv://u:p4ss@cluster0.x.net Bearer abcdefghijklmnop lnk_abcdefghijklmnopqrst',
    );
    expect(out).toContain("E11000 dup key");
    expect(out).not.toMatch(/ann@example\.com|p4ss|abcdefghijklmnop|lnk_abc/);
  });

  it("truncates", () => {
    expect(redactLogText("x".repeat(1000), 50).length).toBeLessThanOrEqual(50);
  });
});

describe("error visibility without DEBUG_LEVEL", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  const saved = { ...process.env };

  beforeEach(() => {
    delete process.env.DEBUG_LEVEL;
    delete process.env.DEBUG_MODE;
    delete process.env.NEXT_PUBLIC_DEBUG_LEVEL;
    delete process.env.ERROR_LOGGING_ENABLED;
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...saved };
    errSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("errorJson always logs one redacted line and keeps the response", async () => {
    const res = errorJson(new Error("boom for bob@example.com"), {
      status: 500,
      publicMessage: "Something went wrong",
      context: "[api/test] failed",
      logMeta: { password: "hunter2" },
    });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Something went wrong");
    expect(errSpy).toHaveBeenCalledTimes(1);
    const [ctx, fields] = errSpy.mock.calls[0]!;
    expect(ctx).toBe("[api/test] failed");
    expect(fields).toMatchObject({ status: 500, name: "Error" });
    const logged = JSON.stringify(errSpy.mock.calls[0]);
    expect(logged).not.toMatch(/bob@example\.com|hunter2|stack/);
  });

  it("sendTextEmail logs a failed Resend send without recipient, body or title", async () => {
    process.env.EMAIL_TRANSPORT = "resend";
    process.env.RESEND_API_KEY = "re_testkeytestkeytestkey";
    process.env.INVITE_EMAIL_FROM = "LinkDrop <hi@lnkdrp.com>";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ statusCode: 422, name: "validation_error", message: "Invalid `to` carol@example.com" }), { status: 422 })),
    );
    await expect(
      sendTextEmail({ to: "carol@lnkdrp.com", subject: "Download request: Secret Deck", text: "private body" }),
    ).rejects.toThrow(/422/);
    expect(errSpy).toHaveBeenCalledTimes(1);
    const [ctx, fields] = errSpy.mock.calls[0]!;
    expect(ctx).toBe("[email] send failed");
    expect(fields).toEqual({ transport: "resend", status: 422, code: "validation_error", kind: "Download request" });
    expect(JSON.stringify(errSpy.mock.calls[0])).not.toMatch(/carol|Secret Deck|private body/);
  });
});
