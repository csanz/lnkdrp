import { describe, expect, test } from "vitest";

import { CLIENT_SETUPS, mcpServerName } from "@/lib/mcp/clientSetups";

/**
 * A key belongs to one workspace and MCP clients keep one server per name, so `/connect` names the
 * connection after the workspace. Every command said `lnkdrp`, and connecting a second workspace
 * replaced (or collided with) the first.
 */
describe("mcpServerName", () => {
  test("personal workspace is lnkdrp-personal; unknown workspace (public guides) stays lnkdrp", () => {
    expect(mcpServerName(null)).toBe("lnkdrp");
    expect(mcpServerName({ name: "Personal", isPersonal: true })).toBe("lnkdrp-personal");
  });

  test("any other workspace gets lnkdrp-<name>, in characters every client accepts", () => {
    expect(mcpServerName({ name: "USAVX", isPersonal: false })).toBe("lnkdrp-usavx");
    expect(mcpServerName({ name: "Café Ventures, LLC!", isPersonal: false })).toBe("lnkdrp-cafe-ventures-llc");
    expect(mcpServerName({ name: "!!!", isPersonal: false })).toBe("lnkdrp-workspace");
    expect(mcpServerName({ name: "A very long workspace name that goes on", isPersonal: false })).toMatch(/^lnkdrp-[a-z0-9-]{1,24}$/);
  });

  test("every client's snippet and remove instructions use the given name", () => {
    for (const setup of CLIENT_SETUPS) {
      const text = [...setup.lines("lnk_x", undefined, "lnkdrp-usavx"), ...setup.steps("lnk_x", undefined, "lnkdrp-usavx").flatMap((s) => s.code ?? [])].join("\n");
      expect(text, setup.key).toContain("lnkdrp-usavx");
      expect(text, setup.key).not.toMatch(/\blnkdrp\b(?!-usavx|\.com|_)/);
      const removal = setup.remove("lnkdrp-usavx");
      expect(removal.body + (removal.code ?? []).join(" "), setup.key).toContain("lnkdrp-usavx");
    }
  });
});
