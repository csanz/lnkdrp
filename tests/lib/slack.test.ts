/**
 * The Slack integration's pure parts (docs/prds/lnkdrp-slack.md, M1): the webhook URL at rest,
 * the signed install state, and how a webhook's answer is classified.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { decryptSlackSecret, encryptSlackSecret, signSlackPayload, verifySlackSignature } from "@/lib/slack/crypto";
import { postToSlackWebhook } from "@/lib/slack/post";
import { createSlackInstallState, SLACK_STATE_TTL_MS, verifySlackInstallState } from "@/lib/slack/state";
import { slackTestMessage } from "@/lib/slack/messages";

const HOOK = "https://hooks.slack.com/services/T000/B000/secretsecret";

describe("the webhook URL at rest", () => {
  test("round-trips, and the stored form contains none of the plaintext", () => {
    const packed = encryptSlackSecret(HOOK);
    expect(packed.split(".")).toHaveLength(3);
    expect(packed).not.toContain("hooks.slack.com");
    expect(packed).not.toContain("secretsecret");
    expect(decryptSlackSecret(packed)).toBe(HOOK);
  });

  test("two encryptions of one URL differ (fresh IV), both decrypt", () => {
    const a = encryptSlackSecret(HOOK);
    const b = encryptSlackSecret(HOOK);
    expect(a).not.toBe(b);
    expect(decryptSlackSecret(a)).toBe(HOOK);
    expect(decryptSlackSecret(b)).toBe(HOOK);
  });

  test("a tampered or malformed value answers null, never throws", () => {
    const packed = encryptSlackSecret(HOOK);
    const [enc, iv, tag] = packed.split(".");
    expect(decryptSlackSecret(`${enc}x.${iv}.${tag}`)).toBeNull();
    expect(decryptSlackSecret(`${enc}.${iv}.AAAA`)).toBeNull();
    expect(decryptSlackSecret("not.packed")).toBeNull();
    expect(decryptSlackSecret("")).toBeNull();
    expect(decryptSlackSecret(null)).toBeNull();
  });

  test("the encryption key and the signing key differ", () => {
    // If they shared a key, a signature oracle would leak key material usable against ciphertext.
    const sig = signSlackPayload("x");
    expect(verifySlackSignature("x", sig)).toBe(true);
    expect(verifySlackSignature("y", sig)).toBe(false);
    expect(verifySlackSignature("x", `${sig.slice(0, -1)}!`)).toBe(false);
  });
});

describe("the install state", () => {
  const orgId = "6ab46f3add6983534677931d";
  const userId = "6ab46f3a542dc85d9d3ba00f";

  test("names the workspace and person, and expires", () => {
    const now = 1_800_000_000_000;
    const state = createSlackInstallState({ orgId, userId, now });
    expect(verifySlackInstallState(state, now)).toEqual({ orgId, userId, exp: now + SLACK_STATE_TTL_MS });
    expect(verifySlackInstallState(state, now + SLACK_STATE_TTL_MS + 1)).toBeNull();
  });

  test("a forged state is refused", () => {
    const state = createSlackInstallState({ orgId, userId });
    const [payload] = state.split(".");
    const other = Buffer.from(JSON.stringify({ orgId: "6ab46f3add6983534677931e", userId, exp: Date.now() + 60_000 })).toString("base64url");
    expect(verifySlackInstallState(`${other}.${state.split(".")[1]}`)).toBeNull();
    expect(verifySlackInstallState(`${payload}.nope`)).toBeNull();
    expect(verifySlackInstallState(payload)).toBeNull();
    expect(verifySlackInstallState(null)).toBeNull();
  });
});

describe("classifying a webhook's answer", () => {
  const respond = (status: number, body: string, headers: Record<string, string> = {}) =>
    vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(body, { status, headers }));

  test("ok is sent", async () => {
    expect(await postToSlackWebhook(HOOK, { text: "hi" }, { fetch: respond(200, "ok") })).toEqual({ kind: "sent" });
  });

  test("a dead webhook is revoked with Slack's reason", async () => {
    expect(await postToSlackWebhook(HOOK, { text: "hi" }, { fetch: respond(404, "no_service") })).toEqual({ kind: "revoked", reason: "no_service" });
    expect(await postToSlackWebhook(HOOK, { text: "hi" }, { fetch: respond(404, "channel_not_found") })).toEqual({ kind: "revoked", reason: "channel_not_found" });
    expect(await postToSlackWebhook(HOOK, { text: "hi" }, { fetch: respond(403, "invalid_token") })).toEqual({ kind: "revoked", reason: "invalid_token" });
  });

  test("429 honours Retry-After, 5xx retries later", async () => {
    expect(await postToSlackWebhook(HOOK, { text: "hi" }, { fetch: respond(429, "", { "retry-after": "7" }) })).toEqual({ kind: "retry", afterMs: 7000, reason: "rate_limited" });
    const r = await postToSlackWebhook(HOOK, { text: "hi" }, { fetch: respond(503, "service_unavailable") });
    expect(r.kind).toBe("retry");
  });

  test("a hang is a retry, not an exception, and never sends the URL anywhere else", async () => {
    const hang = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))));
    const r = await postToSlackWebhook(HOOK, { text: "hi" }, { fetch: hang as unknown as typeof fetch, timeoutMs: 20 });
    expect(r).toEqual({ kind: "retry", afterMs: 30_000, reason: "timeout" });
    expect(hang.mock.calls[0][0]).toBe(HOOK);
  });

  test("the body carries text and blocks", async () => {
    const f = respond(200, "ok");
    const msg = slackTestMessage({ workspaceName: "LNKDRP", channelName: "#deals", appUrl: "https://www.lnkdrp.com" });
    await postToSlackWebhook(HOOK, msg, { fetch: f });
    const init = f.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(init.body)) as { text: string; blocks: unknown[] };
    expect(body.text).toContain("#deals");
    expect(body.blocks).toHaveLength(2);
  });
});

describe("mrkdwn safety", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  test("a channel or workspace name cannot inject markup", () => {
    const msg = slackTestMessage({ workspaceName: "<!channel> & co", channelName: "#x", appUrl: "https://www.lnkdrp.com" });
    const section = (msg.blocks as Array<{ text?: { text: string } }>)[0].text!.text;
    expect(section).toContain("&lt;!channel&gt; &amp; co");
    expect(section).not.toContain("<!channel>");
  });
});
