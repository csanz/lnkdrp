/**
 * One post to one incoming webhook, with the answer classified.
 *
 * Slack's webhook replies are terse: `ok` on success, otherwise a short body such as
 * `no_service`, `channel_not_found`, `invalid_token` or `action_prohibited` with a 4xx status, or
 * `429` with `Retry-After` when a channel is being flooded. The caller needs three answers, not
 * a status code: it went, try again later, or this webhook is dead and the connection should be
 * marked revoked. Everything here is bounded by a timeout and never throws.
 */

export type SlackMessage = {
  /** Plain text, shown in notifications and by clients that do not render blocks. */
  text: string;
  /** Block Kit blocks; optional so a test message can be text only. */
  blocks?: unknown[];
};

export type SlackPostOutcome =
  | { kind: "sent" }
  | { kind: "retry"; afterMs: number; reason: string }
  | { kind: "revoked"; reason: string };

export const SLACK_POST_TIMEOUT_MS = 3_000;

/** Bodies Slack returns for a webhook that will never work again. */
const DEAD_BODIES = new Set(["no_service", "channel_not_found", "invalid_token", "action_prohibited", "no_text", "channel_is_archived", "invalid_payload"]);

const DEFAULT_RETRY_MS = 30_000;

export async function postToSlackWebhook(
  webhookUrl: string,
  message: SlackMessage,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<SlackPostOutcome> {
  const doFetch = opts.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? SLACK_POST_TIMEOUT_MS);
  try {
    const res = await doFetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message.blocks ? { text: message.text, blocks: message.blocks } : { text: message.text }),
      signal: controller.signal,
    });
    const body = (await res.text().catch(() => "")).trim();
    if (res.ok) return { kind: "sent" };
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") ?? "");
      const afterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : DEFAULT_RETRY_MS;
      return { kind: "retry", afterMs, reason: "rate_limited" };
    }
    // `invalid_payload` is our bug, not Slack's: a body we built that Slack rejects will be rejected
    // on every retry, so it is filed with the dead ones rather than retried into `dead`.
    if ((res.status === 404 || res.status === 410 || res.status === 403 || res.status === 400) && DEAD_BODIES.has(body)) {
      return { kind: "revoked", reason: body };
    }
    if (res.status >= 500) return { kind: "retry", afterMs: DEFAULT_RETRY_MS, reason: `http_${res.status}` };
    return { kind: "retry", afterMs: DEFAULT_RETRY_MS, reason: body ? `${res.status}:${body.slice(0, 60)}` : `http_${res.status}` };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return { kind: "retry", afterMs: DEFAULT_RETRY_MS, reason: aborted ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}
