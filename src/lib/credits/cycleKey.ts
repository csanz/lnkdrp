/**
 * The key a workspace's usage rows are filed under for one billing cycle.
 *
 * Two different keys exist and they are not interchangeable:
 *
 * - **Usage** (`CreditLedger.cycleKey`, `UsageAggCycle.cycleKey`): `<workspaceId>:<cycleStart ISO>`,
 *   built here from the balance row's `currentPeriodStart` (or the start of the UTC month when the
 *   workspace has no Stripe period). Stable per workspace and cycle, and independent of Stripe.
 * - **Grants** (`buildCycleKey` in `grants.ts`): `<stripeSubscriptionId>:<unix>`, the idempotency
 *   key of the included-credits grant, tied to Stripe's period.
 *
 * The admin credits page looked up `UsageAggCycle` with the grant key and always found nothing,
 * so every workspace's cycle total read 0 (code review 2026-09-23, M10). Anything that reads usage
 * rows must build the key with this function and the same `cycleStart` the charging path used.
 */

/** Stable per-workspace, per-cycle usage key. `cycleStart` is the balance row's period start. */
export function cycleKeyForUsage(params: { workspaceId: string; cycleStart: Date }): string {
  return `${params.workspaceId}:${params.cycleStart.toISOString()}`;
}

/** Midnight UTC on the first of the month `d` falls in: the cycle start of a workspace with no Stripe period. */
export function startOfUtcMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
}

/**
 * The cycle start the charging path uses for a workspace right now: the balance row's
 * `currentPeriodStart`, else the start of the current UTC month.
 */
export function usageCycleStart(currentPeriodStart: Date | null | undefined, now: Date = new Date()): Date {
  return currentPeriodStart instanceof Date && Number.isFinite(currentPeriodStart.getTime())
    ? currentPeriodStart
    : startOfUtcMonth(now);
}
