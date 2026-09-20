/**
 * Confirmation for destructive tools: the human says yes before anything irreversible happens.
 *
 * Until this existed, `destructiveHint: true` was the only thing between an agent and an
 * irreversible call — and that hint is metadata a client may display, not a gate the server
 * enforces. The handler called the API immediately. The only safeguard was the agent choosing to
 * ask its user in chat first, which is a safeguard that lasts exactly as long as the agent's
 * judgement does.
 *
 * Two mechanisms, chosen by what the connecting client declared at `initialize`:
 *
 * 1. **Elicitation** (`elicitation.form` capability). The server asks the human directly through
 *    the protocol: a form with the consequences spelled out and a single boolean. The agent cannot
 *    answer it — the client renders it to the person. Measured, not assumed: Claude Code 2.1.261
 *    declares `{"elicitation":{"form":{}}}`, so this is the live path for the client this product
 *    is built around.
 *
 * 2. **Explicit `confirm: true`** for clients that do not declare elicitation. The tool refuses
 *    without it and returns the same preview the form would have shown, with
 *    `requiresConfirmation: true`. The tool description tells the agent in plain terms that it must
 *    have the human's go-ahead *in conversation* before setting the flag. This is weaker — it
 *    trusts the agent to ask — but it is the difference between "the agent has to make the ask"
 *    and "the agent can proceed quietly", and a documented fallback beats a silently skipped one.
 *
 * Both paths show the same preview first. A person cannot consent to a deletion they have not
 * seen described: what will go, how much traffic it carried, and whether it can come back.
 *
 * Declaring the capability and being able to answer a request are two different facts. A client
 * can say `elicitation.form` at `initialize` and then never surface the prompt — measured live on
 * Claude Code 2.1.261, where the request times out at the protocol level (`-32001`) every time.
 * Until mt_N2E6syf6Lq, that client had no way through: `confirm` was read only on the
 * no-capability branch, so the escape hatch built for "cannot show the user a prompt" was
 * unreachable for the one client that claimed it could. Now a request that fails to *deliver*
 * (error or timeout) falls through to the `confirm: true` check, exactly as if the capability had
 * never been declared. A human who answered and said no still blocks regardless of `confirm`.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { ToolError } from "./errors";
import { isLocalApiUrl } from "./tools/sharePdf";

/**
 * Skip the prompt while developing against a throwaway database.
 *
 * Confirming every delete is right in production and miserable in a test loop, where an agent may
 * create and destroy fifty objects in a run and a human sits answering prompts about rows that
 * existed for four seconds.
 *
 * Two conditions, both required, and the second is the one that matters:
 *
 * 1. `LNKDRP_SKIP_CONFIRMATIONS` is explicitly set. Nothing is skipped by default, ever.
 * 2. `LNKDRP_API_URL` points at localhost — the *data* is a dev database.
 *
 * The second condition is not the same as "the server process is local", and conflating them is
 * how this feature would cause the accident it is supposed to avoid. A local MCP pointed at
 * https://lnkdrp.com is a normal, supported setup (it is how `filePath` uploads work), and in it a
 * delete destroys a real document belonging to a real workspace. The process being on your laptop
 * says nothing about whose data is at the other end; the API URL does.
 *
 * A flag set against a non-local API is ignored rather than honoured, and says so at startup — a
 * silently disregarded safety switch is worse than one that never existed, because the operator
 * believes something about the system that is not true.
 */
function skipConfirmations(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = (env.LNKDRP_SKIP_CONFIRMATIONS || "").trim().toLowerCase();
  if (!(flag === "1" || flag === "true" || flag === "yes")) return false;
  const apiUrl = (env.LNKDRP_API_URL || "").trim();
  // No API URL configured means the default, which is localhost outside production (config.ts).
  return apiUrl ? isLocalApiUrl(apiUrl) : env.NODE_ENV !== "production";
}

/**
 * Whether the flag was asked for but refused, so the server can say so once at startup rather than
 * leaving the operator to infer it from prompts they did not expect.
 */
export function confirmationsSkipRequestedButUnsafe(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = (env.LNKDRP_SKIP_CONFIRMATIONS || "").trim().toLowerCase();
  const asked = flag === "1" || flag === "true" || flag === "yes";
  return asked && !skipConfirmations(env);
}

/** What a destructive tool is about to do, in terms a person can weigh. */
/**
 * The workspace each session's server acts on, as a getter so a rename picked up by
 * `lnkdrp_whoami` shows. Set by `createMcpServer`; a server without an entry (tests) has no label.
 * A person can have one lnkdrp connection per workspace, so the prompt says which one is about to
 * lose something.
 */
const workspaceLabels = new WeakMap<object, () => string>();

/** Record the workspace name `requireHumanConfirmation` shows for this server. */
export function setConfirmationWorkspace(server: McpServer, label: () => string): void {
  workspaceLabels.set(server, label);
}

export type DestructivePreview = {
  /** One line naming the action and the target, e.g. `Delete the link "Sequoia" on "Q3 deck"`. */
  headline: string;
  /** Facts that bear on the decision, one per line. Traffic first — it is the one that changes minds. */
  facts: string[];
  /**
   * How much is at stake. `high` when the target has recipient traffic or the action takes several
   * links down at once; `low` when nothing has ever been opened. The tool description tells the
   * agent that a `high` preview is one to put to the human rather than confirm on its own.
   */
  severity: "low" | "high";
  /** Whether the action can be undone from the app. Deletes cannot; archives can. */
  reversible: boolean;
};

/**
 * True when the connected client told us at `initialize` that it can render an elicitation form.
 * Read from the live server, never cached: the capability is per connection, not per process.
 */
export function clientSupportsElicitation(server: McpServer): boolean {
  const caps = server.server.getClientCapabilities() as { elicitation?: { form?: unknown } } | undefined;
  return Boolean(caps?.elicitation && typeof caps.elicitation === "object" && "form" in caps.elicitation);
}

/**
 * Obtain confirmation, or throw a `ToolError` that carries the preview.
 *
 * Resolves only when a human has said yes. Every other outcome — declined, cancelled, no
 * elicitation support and no `confirm: true`, or an elicitation that itself failed — throws, so
 * the calling tool cannot proceed by accident. The thrown error's `details` carry the full
 * preview and `requiresConfirmation: true`, which is what an agent without elicitation support
 * reads back to its user before asking.
 */
export async function requireHumanConfirmation(
  server: McpServer,
  preview: DestructivePreview,
  args: { confirm?: boolean | undefined },
): Promise<{ via: "elicitation" | "confirm_flag"; elicitationFailed?: true }> {
  // Dev escape hatch, gated on the data being a dev database rather than on where this process
  // runs. See `skipConfirmations`.
  if (skipConfirmations()) return { via: "confirm_flag" };

  const workspace = workspaceLabels.get(server)?.() ?? null;
  const previewDetails = {
    requiresConfirmation: true,
    ...(workspace ? { workspace } : {}),
    preview,
    reversible: preview.reversible,
    severity: preview.severity,
  };

  if (clientSupportsElicitation(server)) {
    let result: { action: string; content?: Record<string, unknown> | undefined };
    try {
      result = await server.server.elicitInput({
        mode: "form",
        message:
          `${preview.headline}${workspace ? ` (workspace: ${workspace})` : ""}\n\n` +
          preview.facts.map((f) => `• ${f}`).join("\n") +
          `\n\n${preview.reversible ? "This can be undone from the app." : "This cannot be undone."}`,
        requestedSchema: {
          type: "object",
          properties: {
            confirmed: {
              type: "boolean",
              title: preview.reversible ? "Yes, do it" : "Yes, delete it — I understand this cannot be undone",
              description: "Untick or cancel to keep everything as it is.",
            },
          },
          required: ["confirmed"],
        },
      });
    } catch (err) {
      // The request never reached a human (timeout, transport error): nobody said no, nobody said
      // yes. Treat it exactly like a client without elicitation — proceed on the agent's explicit
      // `confirm: true`, otherwise refuse with the preview so the agent can ask in conversation.
      if (args.confirm === true) return { via: "confirm_flag", elicitationFailed: true };
      throw new ToolError(
        "validation",
        `Could not ask the user to confirm (${err instanceof Error ? err.message : String(err)}). Nothing was changed. ` +
          `Show them the preview in details, get an explicit yes, then call again with confirm: true.`,
        { status: 400, details: { ...previewDetails, elicitationFailed: true } },
      );
    }
    if (result.action === "accept" && result.content?.confirmed === true) return { via: "elicitation" };
    // `cancel` means the form was dismissed without an answer. Some clients return it with nobody
    // there at all (Claude Code in `-p` mode cancels instantly), but it is indistinguishable from a
    // person pressing Escape, so it stays final like a decline. What differs is the guidance: the
    // agent needs to know a retry cannot get through and where the human can act instead.
    if (result.action === "cancel") {
      // `cancel` is "dismissed without an answer", which the protocol keeps separate from `decline`.
      // Clients that cannot render the form return it instantly and nobody ever saw the question —
      // measured 2026-09-18, when an interactive Claude Code session timed out on the first call and
      // got `cancel` on the retry, leaving deletes unreachable from every client we have. So it is
      // treated exactly like a prompt that failed to deliver: the agent's `confirm: true`, its
      // assertion that the human said yes in conversation, goes through. An explicit `decline`
      // below still cannot be overridden.
      if (args.confirm === true) return { via: "confirm_flag", elicitationFailed: true };
      throw new ToolError(
        "validation",
        "The confirmation prompt was dismissed without an answer (a client that cannot show it dismisses it " +
          "automatically). Nothing was changed. Show the user the preview in details, get an explicit yes in " +
          "conversation, then call again with confirm: true.",
        { status: 400, details: { ...previewDetails, userAction: result.action } },
      );
    }
    // Declined, or accepted with the box unticked: a human answered no, so `confirm: true` does not
    // override it.
    throw new ToolError("validation", "The user declined. Nothing was changed; calling again with confirm: true will not override it.", {
      status: 400,
      details: { ...previewDetails, userAction: result.action },
    });
  }

  // No elicitation: the agent must have asked. `confirm: true` is its assertion that it did.
  if (args.confirm === true) return { via: "confirm_flag" };
  throw new ToolError(
    "validation",
    `${preview.headline}${workspace ? ` in the workspace ${workspace}` : ""}. This needs the user's explicit go-ahead. Show them the facts in details.preview, ` +
      `ask, and only if they say yes call this tool again with confirm: true. ` +
      // Keyed on what the preview actually says, not on severity alone: `severityFromTraffic`
      // also returns "high" for more than one live link, so a document nobody has opened was being
      // described as having "real recipient traffic" directly above facts reading "Never opened by
      // a recipient". A confirmation prompt that contradicts its own evidence teaches the reader to
      // skip the prose.
      (preview.severity === "high"
        ? "Several people may lose access at once — recipients have opened this, or more than one live link stops " +
          "resolving. Do not confirm on your own judgement."
        : "Nothing has opened this yet, so the stakes are low, but the ask is still required."),
    { status: 400, details: previewDetails },
  );
}

/** Grade a target by its traffic: any recipient view makes deletion a `high`-stakes act. */
export function severityFromTraffic(input: { recipientViews: number; recentViews?: number; activeLinks?: number }): "low" | "high" {
  if (input.recipientViews > 0) return "high";
  if ((input.recentViews ?? 0) > 0) return "high";
  if ((input.activeLinks ?? 0) > 1) return "high";
  return "low";
}
