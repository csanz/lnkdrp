/**
 * `lnkdrp_get_share_link_password` and `lnkdrp_verify_share_password` — mt_GOKLLvF4-v.
 *
 * Setting a password over MCP returned `passwordEnabled: true` and nothing else, so an agent could
 * not say which password was set or whether it opened the link. That is not a cosmetic gap: it is
 * how the incident behind mt_eqYXr8Z5Pn ended with the owner locked out. The agent set a password,
 * the only copy of it was a chat message, and the next session had no way to recover it.
 *
 * Two tools rather than one, because they are different asks with different exposure:
 *
 * - **Verify** answers "does this open it" without handing back the secret. It is the one to reach
 *   for when confirming a password the human already gave you, which is the common case.
 * - **Read back** hands over the plain text. That is what "remind me what Jeff's password is"
 *   needs, and nothing weaker will do it. Every read writes an activity row, so a password leaving
 *   the system leaves a trace the owner can see.
 *
 * Both are admin-or-owner on the key's own workspace, one step above the `member` that editing a
 * link takes: reading a secret out is not the same permission as setting one.
 *
 * Verify deliberately does not go through the recipient's unlock route. That route sets a share
 * auth cookie, records a view, and spends the recipient's budget of 10 attempts per IP per share
 * per 5 minutes — so an agent testing a password would put fake traffic on the link and could lock
 * out the person it was made for. The owner-side route compares against the stored hash, writes
 * nothing, and carries its own limiter.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ToolContext } from "../context";
import { handleTool } from "../errors";
import { SAFETY_TAIL } from "./shared";

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
const docIdSchema = z.string().regex(OBJECT_ID_RE, "docId must be a 24-character hex id").describe("Document id (24 hex chars).");
const linkIdSchema = z.string().regex(OBJECT_ID_RE, "linkId must be a 24-character hex id").describe("Share link id (24 hex chars), from lnkdrp_list_share_links.");

export const getShareLinkPasswordInputShape = {
  docId: docIdSchema,
  linkId: linkIdSchema,
};

export const verifySharePasswordInputShape = {
  docId: docIdSchema,
  linkId: linkIdSchema,
  password: z.string().min(1).max(128).describe("The password to test against this link."),
};

/** Register `lnkdrp_get_share_link_password`. */
export function registerGetShareLinkPasswordTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "lnkdrp_get_share_link_password",
    {
      title: "Show a link's password",
      description:
        "Return the password set on one share link, in plain text, so you can tell the human what it is at any time - not " +
        "only in the turn where you set it. Use this when they ask what a link's password is. When you only need to " +
        "confirm a password they already gave you, prefer lnkdrp_verify_share_password, which answers without handing the " +
        "secret back. Returns { passwordEnabled, password }: password is null when the link has none, and also when the " +
        "link is old enough that only its hash survives, which passwordEnabled tells apart. Owner or admin of the key's " +
        "own workspace. Every read is written to the workspace activity feed, so the owner can see that it happened. " +
        SAFETY_TAIL,
      inputSchema: getShareLinkPasswordInputShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handleTool(async (args) => {
      const res = await ctx.api.getShareLinkPassword(args.docId, args.linkId);
      return { docId: args.docId, linkId: args.linkId, passwordEnabled: res.passwordEnabled, password: res.password };
    }),
  );
}

/** Register `lnkdrp_verify_share_password`. */
export function registerVerifySharePasswordTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "lnkdrp_verify_share_password",
    {
      title: "Check a link's password",
      description:
        "Test whether a password opens a share link, without revealing what the real one is. Use it to confirm the " +
        "password a human gave you actually works, after setting it or before passing it on. Returns { passwordEnabled, " +
        "matches, linkStatus, opensLink }; matches is false whenever the link has no password at all. matches only compares " +
        "the password, so check opensLink before telling the human the link works: it is true when the link is active and " +
        "either the password matches or the link needs none (an open link opens for anyone). This is safe to call: it does not open the " +
        "link, does not record a view, and does not spend the recipient's unlock attempts - a recipient gets only 10 " +
        "tries per 5 minutes, so checking through the public link could lock out the person it was made for. This tool " +
        "has its own separate limit of 20 checks per link per 5 minutes. Owner or admin of the key's own workspace. " +
        SAFETY_TAIL,
      inputSchema: verifySharePasswordInputShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handleTool(async (args) => {
      const res = await ctx.api.verifyShareLinkPassword(args.docId, args.linkId, args.password);
      // A matching password on a disabled or expired link still opens nothing. Without the link's
      // status an agent told the human "the password works" about a link nobody can open.
      const link = (await ctx.api.listShareLinks(args.docId)).find((l) => l.id === args.linkId) ?? null;
      const linkStatus = link?.status ?? null;
      return {
        docId: args.docId,
        linkId: args.linkId,
        passwordEnabled: res.passwordEnabled,
        matches: res.matches,
        linkStatus,
        // "does this link open for the person holding this password", which for a link with no
        // password at all is yes: it opens for anyone. Tied to matches alone, this read false for a
        // perfectly live open link, and the description tells agents to act on it.
        opensLink: linkStatus === "active" && (res.passwordEnabled ? res.matches : true),
      };
    }),
  );
}
