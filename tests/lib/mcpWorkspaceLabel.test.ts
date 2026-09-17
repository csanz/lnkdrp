import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { Whoami } from "../../mcp/src/api";
import { requireHumanConfirmation, setConfirmationWorkspace } from "../../mcp/src/confirm";
import type { ToolContext } from "../../mcp/src/context";
import { ToolError, toolErrorResult, toolResult } from "../../mcp/src/errors";
import { SERVER_INSTRUCTIONS, createMcpServer, withWorkspace, workspaceInstructions } from "../../mcp/src/server";

/**
 * A person can connect one lnkdrp server per workspace (`lnkdrp`, `lnkdrp-usavx`), all with the same
 * tools. The server says which workspace it acts on in its instructions, on every result, and in
 * destructive prompts, so "add this to USAVX" and "which one did that land in" have an answer.
 */
const usavx: Whoami = {
  ok: true,
  userId: "u1",
  email: null,
  orgId: "6aac134ac99e869f18f2eff0",
  orgName: "USAVX",
  isPersonalOrg: false,
  plan: "free",
  keyPrefix: "lnk_abc",
  scopes: [],
  client: "test",
};

describe("workspaceInstructions", () => {
  it("names the workspace and says to ask when more than one connection is available", () => {
    const text = workspaceInstructions(usavx);
    expect(text).toContain('workspace "USAVX" (team workspace, Free plan)');
    expect(text).toContain("ask before creating, changing or deleting anything");
    expect(workspaceInstructions({ orgName: null, isPersonalOrg: true, plan: "pro" })).toContain('"Personal" (personal workspace, Pro plan)');
  });
});

describe("withWorkspace", () => {
  it("adds workspace to structured content and its JSON text", () => {
    const out = withWorkspace(toolResult({ shareUrl: "https://x/s/1" }), usavx);
    expect(out.structuredContent).toEqual({ workspace: { id: usavx.orgId, name: "USAVX" }, shareUrl: "https://x/s/1" });
    expect(JSON.parse((out.content[0] as { text: string }).text)).toEqual(out.structuredContent);
  });

  it("leaves errors and a tool's own workspace field alone", () => {
    const err = toolErrorResult(new ToolError("validation", "nope"));
    expect(withWorkspace(err, usavx)).toBe(err);
    const own = toolResult({ workspace: "kept" });
    expect(withWorkspace(own, usavx)).toBe(own);
  });
});

describe("createMcpServer", () => {
  it("sends the workspace in instructions and labels every tool result", async () => {
    const ctx = { whoami: () => usavx } as unknown as ToolContext;
    const server = createMcpServer(ctx);
    server.registerTool("probe", { description: "test" }, async () => toolResult({ done: true }));

    const client = new Client({ name: "test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const instructions = client.getInstructions() ?? "";
    expect(instructions.startsWith('This connection acts on the lnkdrp workspace "USAVX"')).toBe(true);
    expect(instructions.endsWith(SERVER_INSTRUCTIONS)).toBe(true);

    const result = await client.callTool({ name: "probe", arguments: {} });
    expect(result.structuredContent).toEqual({ workspace: { id: usavx.orgId, name: "USAVX" }, done: true });
    await client.close();
  });
});

describe("requireHumanConfirmation workspace", () => {
  const preview = { headline: "Delete x", facts: ["never opened"], severity: "low" as const, reversible: false };

  it("names the workspace in the elicitation prompt", async () => {
    let message = "";
    const server = {
      server: {
        getClientCapabilities: () => ({ elicitation: { form: {} } }),
        elicitInput: async (req: { message: string }) => {
          message = req.message;
          return { action: "accept", content: { confirmed: true } };
        },
      },
    } as unknown as Parameters<typeof requireHumanConfirmation>[0];
    setConfirmationWorkspace(server, () => "USAVX");
    await requireHumanConfirmation(server, preview, {});
    expect(message.split("\n")[0]).toBe("Delete x (workspace: USAVX)");
  });

  it("names it in the refusal a client without elicitation gets", async () => {
    const server = { server: { getClientCapabilities: () => ({}) } } as unknown as Parameters<typeof requireHumanConfirmation>[0];
    setConfirmationWorkspace(server, () => "USAVX");
    const err = await requireHumanConfirmation(server, preview, {}).catch((e: unknown) => e as ToolError);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).message).toContain("Delete x in the workspace USAVX.");
    expect(((err as ToolError).details as { workspace: string }).workspace).toBe("USAVX");
  });
});
