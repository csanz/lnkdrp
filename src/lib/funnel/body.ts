/**
 * The `POST /api/funnel` body contract: which steps the browser may report, what it may press, and
 * the parser that turns a request body into a validated `FunnelBody` or a sentence saying what is
 * wrong. Lives outside the route module because Next only allows HTTP handlers and route config
 * to be exported from one, and the admin funnel report and the route's tests both need these.
 */
/** Funnel steps the browser may report. */
export const FUNNEL_EVENTS = ["modal_shown", "cta_clicked", "teaser_shown"] as const;
/** What can be pressed on an upgrade or out-of-credits modal. */
export const FUNNEL_CTAS = ["upgrade", "pack", "compare", "manage", "dismiss"] as const;

/** A validated request body. */
export type FunnelBody = {
  event: (typeof FUNNEL_EVENTS)[number];
  reason: string | null;
  cta: (typeof FUNNEL_CTAS)[number] | null;
  from: string | null;
  /** `teaser_shown` only: the lifetime viewer counts the teaser was showing. */
  uniqueViewers: number | null;
  identifiedViewers: number | null;
};

const TOKEN_RE = /^[a-z0-9_.-]{1,64}$/i;

/** Parse and validate the body; a string says what is wrong. */
export function parseFunnelBody(raw: unknown): FunnelBody | string {
  if (!raw || typeof raw !== "object") return "Body must be a JSON object";
  const b = raw as Record<string, unknown>;
  const event = typeof b.event === "string" ? b.event : "";
  if (!(FUNNEL_EVENTS as readonly string[]).includes(event)) return `event must be one of ${FUNNEL_EVENTS.join(", ")}`;
  const token = (v: unknown, name: string): string | null | Error => {
    if (v === undefined || v === null || v === "") return null;
    if (typeof v !== "string" || !TOKEN_RE.test(v)) return new Error(`${name} must be a short token`);
    return v;
  };
  const reason = token(b.reason, "reason");
  if (reason instanceof Error) return reason.message;
  const from = token(b.from, "from");
  if (from instanceof Error) return from.message;
  const ctaRaw = b.cta === undefined || b.cta === null || b.cta === "" ? null : b.cta;
  if (ctaRaw !== null && !(FUNNEL_CTAS as readonly unknown[]).includes(ctaRaw)) return `cta must be one of ${FUNNEL_CTAS.join(", ")}`;
  const cta = ctaRaw as FunnelBody["cta"];
  if (event === "cta_clicked" && !cta) return "cta is required for cta_clicked";
  const count = (v: unknown, name: string): number | null | Error => {
    if (event !== "teaser_shown" || v === undefined || v === null) return null;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1_000_000_000) return new Error(`${name} must be a count`);
    return Math.floor(v);
  };
  const uniqueViewers = count(b.uniqueViewers, "uniqueViewers");
  if (uniqueViewers instanceof Error) return uniqueViewers.message;
  const identifiedViewers = count(b.identifiedViewers, "identifiedViewers");
  if (identifiedViewers instanceof Error) return identifiedViewers.message;
  return { event: event as FunnelBody["event"], reason, cta, from, uniqueViewers, identifiedViewers };
}
