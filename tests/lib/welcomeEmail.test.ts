/**
 * The welcome email, and the two conditions that decide whether it is sent at all.
 *
 * The body is the easy half. The half worth pinning is the wiring in `src/lib/auth.ts`, because
 * both of its guards fail silently and in opposite directions:
 *
 *   - Gate on **insert**, not on "we didn't find a row a moment ago". The `signIn` callback reads
 *     the user before it upserts, and two tabs racing through Google both see `null` — so a check
 *     against that read sends the welcome twice. `lastErrorObject.upserted` is set by the server
 *     only on the call that actually inserted, which is the one signal that cannot double.
 *
 *   - Gate on **approved**, not on "new". A waitlisted signup is a brand-new row too, and greeting
 *     them with "your account is ready, upload a PDF" moments before the queue page tells them to
 *     wait is the single worst version of this email. Theirs is `waitlist_approved`, later.
 *
 * Neither guard is visible in the body, so neither would survive a rewrite of this file that only
 * checked the copy.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { EMAIL_CATALOG, welcomeEmail } from "@/lib/email/templates";
import { FREE_DOCUMENTS } from "@/lib/billing/planLimits";
import { FREE_STARTER_CREDITS } from "@/lib/credits/grants";

const REPO_ROOT = path.resolve(__dirname, "../..");
const AUTH_SRC = fs.readFileSync(path.join(REPO_ROOT, "src/lib/auth.ts"), "utf8");

describe("welcome email body", () => {
  test("greets them by first name only", () => {
    const mail = welcomeEmail({ name: "Dana Lee", appUrl: "https://lnkdrp.com" });
    expect(mail.subject).toBe("Welcome to LinkDrop");
    expect(mail.text.startsWith("Welcome, Dana.")).toBe(true);
    expect(mail.text).not.toContain("Dana Lee");
  });

  test("still reads as a sentence when Google gives us no name", () => {
    const mail = welcomeEmail({ name: null, appUrl: "https://lnkdrp.com" });
    expect(mail.text.startsWith("Welcome.")).toBe(true);
    // The failure this guards is "Welcome, ." — a greeting with a hole in it.
    expect(mail.text).not.toMatch(/Welcome,\s*\./);
  });

  test("quotes the real plan numbers, not copies of them", () => {
    const mail = welcomeEmail({ name: "Dana", appUrl: "https://lnkdrp.com" });
    expect(mail.text).toContain(`${FREE_DOCUMENTS} shared documents`);
    expect(mail.text).toContain(`${FREE_STARTER_CREDITS} credits`);
    expect(mail.text).toContain("No card needed.");
  });

  test("points at the dashboard, and omits the line rather than printing a bare slash", () => {
    expect(welcomeEmail({ name: "Dana", appUrl: "https://lnkdrp.com" }).text).toContain(
      "https://lnkdrp.com/dashboard",
    );
    const noUrl = welcomeEmail({ name: "Dana", appUrl: "" }).text;
    expect(noUrl).not.toContain("Your dashboard:");
    expect(noUrl).not.toContain("/dashboard");
  });

  test("does not promise to be the only email we ever send", () => {
    // `plan_limit` and `member_removed` are both account-level mail. A welcome that claims
    // otherwise is a lie with a delayed fuse.
    expect(welcomeEmail({ name: "Dana" }).text).not.toMatch(/only email/i);
  });

  test("ends with the shared signature", () => {
    expect(welcomeEmail({ name: "Dana" }).text.trimEnd().endsWith("- LinkDrop")).toBe(true);
  });

  test("is in the catalogue, so the admin list of what we send stays honest", () => {
    const row = EMAIL_CATALOG.find((r) => r.id === "welcome");
    expect(row).toBeTruthy();
    expect(row?.builtBy).toBe("templates/welcome.ts");
  });
});

describe("welcome email wiring", () => {
  test("sign-in sends it", () => {
    expect(AUTH_SRC).toContain("sendWelcomeEmail");
  });

  test("it is gated on the upsert that inserted, not on the earlier read", () => {
    expect(AUTH_SRC).toContain("upsert?.lastErrorObject?.upserted");
    // Without this option Mongoose returns the document and `lastErrorObject` is undefined —
    // which is falsy, so the email would silently never send.
    expect(AUTH_SRC).toContain("includeResultMetadata: true");
  });

  test("a waitlisted signup gets no welcome", () => {
    const guard = AUTH_SRC.match(/if \(upsert\?\.lastErrorObject\?\.upserted[^)]*\)/);
    expect(guard).toBeTruthy();
    expect(guard?.[0]).toContain('initialStatus === "approved"');
  });

  test("a send that throws cannot fail the sign-in", () => {
    const sender = fs.readFileSync(path.join(REPO_ROOT, "src/lib/email/sendWelcomeEmail.ts"), "utf8");
    expect(sender).toMatch(/catch\s*\(/);
    // Nothing may be rethrown: `signIn` turns a throw into a failed login.
    expect(sender).not.toMatch(/\bthrow\b/);
  });
});
