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

/** What a destructive tool is about to do, in terms a person can weigh. */
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
  const previewDetails = {
    requiresConfirmation: true,
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
          `${preview.headline}\n\n` +
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
    // Declined, cancelled, or accepted with the box unticked: all of these mean no. A human answered,
    // so `confirm: true` does not override it.
    throw new ToolError("validation", "The user did not confirm. Nothing was changed.", {
      status: 400,
      details: { ...previewDetails, userAction: result.action },
    });
  }

  // No elicitation: the agent must have asked. `confirm: true` is its assertion that it did.
  if (args.confirm === true) return { via: "confirm_flag" };
  throw new ToolError(
    "validation",
    `${preview.headline}. This needs the user's explicit go-ahead. Show them the facts in details.preview, ` +
      `ask, and only if they say yes call this tool again with confirm: true. ` +
      (preview.severity === "high"
        ? "This target has real recipient traffic — do not confirm on your own judgement."
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
