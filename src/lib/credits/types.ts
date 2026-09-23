/**
 * `brief`: the visit brief — the model's account of one recipient's reading session, written a
 * few minutes after the visit ends (docs/prds/lnkdrp-visit-briefs.md). The one action that starts
 * from a reader's behaviour rather than from an upload or a click.
 */
export type ActionType = "summary" | "review" | "history" | "brief" | "unknown";

export type QualityTier = "basic" | "standard" | "advanced";

export type LedgerStatus = "pending" | "charged" | "refunded" | "failed";

export type CreditBucket = "trial" | "subscription" | "purchased" | "on_demand";


