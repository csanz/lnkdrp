import { describe, expect, it } from "vitest";

import { requireHumanConfirmation, type DestructivePreview } from "../../mcp/src/confirm";
import { ToolError } from "../../mcp/src/errors";

/**
 * `requireHumanConfirmation` against a fake server. The point under test is the one that bit live
 * (mt_N2E6syf6Lq): a client that declares elicitation but whose requests never resolve must be
 * able to proceed on `confirm: true`, while a human who answered no stays final.
 */
const preview: DestructivePreview = { headline: "Delete x", facts: ["never opened"], severity: "low", reversible: false };

function fakeServer(caps: object | undefined, elicit: () => Promise<{ action: string; content?: Record<string, unknown> }>) {
  return { server: { getClientCapabilities: () => caps, elicitInput: elicit } } as unknown as Parameters<typeof requireHumanConfirmation>[0];
}
const withElicitation = { elicitation: { form: {} } };
const timeout = () => Promise.reject(Object.assign(new Error("MCP error -32001: Request timed out"), { code: -32001 }));

async function refusal(p: Promise<unknown>): Promise<ToolError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ToolError) return err;
    throw err;
  }
  throw new Error("expected a ToolError refusal");
}

describe("requireHumanConfirmation", () => {
  it("proceeds on an accepted elicitation", async () => {
    const r = await requireHumanConfirmation(fakeServer(withElicitation, async () => ({ action: "accept", content: { confirmed: true } })), preview, {});
    expect(r).toEqual({ via: "elicitation" });
  });

  it("a human decline is final, even with confirm: true", async () => {
    for (const answer of [{ action: "decline" }, { action: "cancel" }, { action: "accept", content: { confirmed: false } }]) {
      const err = await refusal(requireHumanConfirmation(fakeServer(withElicitation, async () => answer), preview, { confirm: true }));
      expect(err.code).toBe("validation");
      expect((err.details as { userAction: string }).userAction).toBe(answer.action);
    }
  });

  it("an elicitation that times out refuses with the preview when confirm is absent", async () => {
    const err = await refusal(requireHumanConfirmation(fakeServer(withElicitation, timeout), preview, {}));
    expect(err.code).toBe("validation");
    const d = err.details as { requiresConfirmation: boolean; elicitationFailed: boolean; preview: DestructivePreview };
    expect(d.requiresConfirmation).toBe(true);
    expect(d.elicitationFailed).toBe(true);
    expect(d.preview).toEqual(preview);
    expect(err.message).toContain("confirm: true");
  });

  it("an elicitation that times out falls through to confirm: true (the live bug)", async () => {
    const r = await requireHumanConfirmation(fakeServer(withElicitation, timeout), preview, { confirm: true });
    expect(r).toEqual({ via: "confirm_flag", elicitationFailed: true });
  });

  it("without the capability, confirm: true is the only way through and nothing is elicited", async () => {
    let asked = 0;
    const server = fakeServer(undefined, async () => { asked += 1; return { action: "accept", content: { confirmed: true } }; });
    const err = await refusal(requireHumanConfirmation(server, preview, {}));
    expect((err.details as { requiresConfirmation: boolean }).requiresConfirmation).toBe(true);
    expect(await requireHumanConfirmation(server, preview, { confirm: true })).toEqual({ via: "confirm_flag" });
    expect(asked).toBe(0);
  });
});
