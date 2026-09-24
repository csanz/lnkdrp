/**
 * The OAuth `state` for the Slack install: who started it, for which workspace, until when.
 *
 * Slack sends `state` back untouched on the callback. Signing it means the callback can trust the
 * workspace and user it names without a session lookup that could have changed meanwhile (a
 * workspace switch mid-flow), and a forged or replayed callback cannot attach a channel to
 * somebody else's workspace. Ten minutes is long enough to read Slack's screen and pick a channel.
 */
import { signSlackPayload, verifySlackSignature } from "./crypto";

export const SLACK_STATE_TTL_MS = 10 * 60 * 1000;

export type SlackInstallState = { orgId: string; userId: string; exp: number };

export function createSlackInstallState(input: { orgId: string; userId: string; now?: number }): string {
  const body: SlackInstallState = { orgId: input.orgId, userId: input.userId, exp: (input.now ?? Date.now()) + SLACK_STATE_TTL_MS };
  const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
  return `${payload}.${signSlackPayload(payload)}`;
}

/** The state's contents, or `null` when the signature is wrong, the shape is off, or it expired. */
export function verifySlackInstallState(state: string | null | undefined, now: number = Date.now()): SlackInstallState | null {
  if (!state || typeof state !== "string") return null;
  const dot = state.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = state.slice(0, dot);
  const signature = state.slice(dot + 1);
  if (!verifySlackSignature(payload, signature)) return null;
  try {
    const body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<SlackInstallState>;
    if (typeof body.orgId !== "string" || typeof body.userId !== "string" || typeof body.exp !== "number") return null;
    if (body.exp < now) return null;
    return { orgId: body.orgId, userId: body.userId, exp: body.exp };
  } catch {
    return null;
  }
}
