import { describe, expect, test, vi } from "vitest";
import {
  parseNotificationEmailsArgs,
  runNotificationEmailsCli,
  type NotificationEmailsCliDeps,
} from "@/lib/notifications/sendNotificationEmailsCli";

function deps(overrides: Partial<NotificationEmailsCliDeps> = {}) {
  const log = vi.fn();
  const disconnect = vi.fn(async () => undefined);
  const d: NotificationEmailsCliDeps = {
    send: vi.fn(async () => ({ ok: true }) as never),
    disconnect,
    log,
    logError: vi.fn(),
    ...overrides,
  };
  return Object.assign(d, { logMock: log, disconnectMock: disconnect });
}

describe("notifications-send-emails CLI", () => {
  test("parses flags; dry run unless --send", () => {
    expect(parseNotificationEmailsArgs([])).toEqual({ dryRun: true, forceDigest: false, workspaceId: null, userId: null });
    expect(parseNotificationEmailsArgs(["--send", "--forceDigest", "--workspaceId", "w1", "--userId", "u1"])).toEqual({
      dryRun: false,
      forceDigest: true,
      workspaceId: "w1",
      userId: "u1",
    });
    expect(parseNotificationEmailsArgs(["--workspaceId", "--send"]).workspaceId).toBeNull();
  });

  test("closes the Mongo connection after printing the result, so the process can exit", async () => {
    const d = deps();
    const code = await runNotificationEmailsCli(["--forceDigest"], d);
    expect(code).toBe(0);
    expect(d.send).toHaveBeenCalledWith({ dryRun: true, forceDigest: true, workspaceId: null, userId: null });
    expect(d.log).toHaveBeenCalledWith(JSON.stringify({ ok: true }, null, 2));
    expect(d.disconnect).toHaveBeenCalledTimes(1);
    expect(d.logMock.mock.invocationCallOrder[0]).toBeLessThan(d.disconnectMock.mock.invocationCallOrder[0]);
  });

  test("still disconnects when the run throws, and exits 1", async () => {
    const d = deps({ send: vi.fn(async () => Promise.reject(new Error("mongo down"))) });
    const code = await runNotificationEmailsCli([], d);
    expect(code).toBe(1);
    expect(d.logError).toHaveBeenCalled();
    expect(d.disconnect).toHaveBeenCalledTimes(1);
  });

  test("a failed disconnect is reported with exit 1", async () => {
    const d = deps({ disconnect: vi.fn(async () => Promise.reject(new Error("close failed"))) });
    expect(await runNotificationEmailsCli([], d)).toBe(1);
  });

  test("the script wires the real disconnect", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../../scripts/notifications-send-emails.ts", import.meta.url), "utf8");
    expect(src).toContain("runNotificationEmailsCli(");
    expect(src).toMatch(/disconnect:\s*\(\)\s*=>\s*mongoose\.disconnect\(\)/);
  });
});
