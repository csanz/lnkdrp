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
  /**
   * Plain text, shown in notifications and by clients that do not render blocks.
   *
   * Not a summary of the blocks but a message in its own right: Slack reads only this for mobile
   * notifications and for screen readers, which never reach the interior blocks. It must therefore
   * say the whole thing on its own, and it carries no emoji so it reads as a sentence. Where it
   * travels in the payload depends on whether there is a colour — see `slackPostBody`, which is the
   * one place that decides.
   */
  text: string;
  /** Block Kit blocks; optional so a test message can be text only. */
  blocks?: unknown[];
  /**
   * The attachment's left border, as a hex colour. What gives the channel a hierarchy: a recipient
   * opening a document and a teammate filing one used to look identical, and the one the product
   * exists for is the first.
   *
   * Sending `blocks` inside an `attachment` is the documented way to have both Block Kit layout and
   * a colour — the attachment's own `blocks` and `color` are the two fields Slack still lists as
   * current there, with every other attachment field marked legacy. Without a colour the blocks go
   * at the top level as before.
   */
  color?: string;
};

export type SlackPostOutcome =
  | { kind: "sent" }
  | { kind: "retry"; afterMs: number; reason: string }
  | { kind: "revoked"; reason: string };

export const SLACK_POST_TIMEOUT_MS = 3_000;

/** Bodies Slack returns for a webhook that will never work again. */
const DEAD_BODIES = new Set(["no_service", "channel_not_found", "invalid_token", "action_prohibited", "no_text", "channel_is_archived", "invalid_payload"]);

const DEFAULT_RETRY_MS = 30_000;

/**
 * The JSON one message becomes.
 *
 * `unfurl_links` and `unfurl_media` are off on every post, and both are needed: the first governs
 * text-based links and the second media, and Slack treats them as separate switches rather than one.
 * Slack unfurls links in app messages by default, and every URL these messages carry points back
 * into the signed-in app, so an unfurl could only ever add the marketing card a logged-out fetch
 * returns — underneath a message that already says the thing properly. These two fields work on an
 * incoming webhook, which is worth saying because most of the message-shaping controls do not.
 */
export function slackPostBody(message: SlackMessage): Record<string, unknown> {
  const body: Record<string, unknown> = { unfurl_links: false, unfurl_media: false };
  if (message.blocks?.length && message.color) {
    /**
     * `text` moves *into* the attachment, and this is the whole reason this function exists.
     *
     * Alongside `blocks` at the top level, `text` is a fallback: Slack renders the blocks and reads
     * the text only for notifications. Alongside an `attachment`, it is not — Slack renders the text
     * as the message and hangs the attachment underneath it, so every post said everything twice,
     * once plain and once with its mark. `fallback` is the field that plays the fallback role for an
     * attachment, and it feeds the same notification and screen-reader path.
     */
    body.attachments = [{ color: message.color, blocks: message.blocks, fallback: message.text }];
  } else {
    body.text = message.text;
    if (message.blocks?.length) body.blocks = message.blocks;
  }
  return body;
}

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
      body: JSON.stringify(slackPostBody(message)),
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
