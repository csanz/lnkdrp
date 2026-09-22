/**
 * A cron route that cannot honour `?dryRun=1` must say so rather than run for real.
 *
 * `scripts/cron/lib.ts` adds `dryRun=1` to whichever job you name — it is a property of the CLI,
 * not of the job — so every route receives the flag whether or not it implements it. Five did not,
 * and ignored it silently: `npm run cron:stripe-credits-report -- --dry-run` reported meter events
 * to Stripe and billed for them, which is the single worst thing a command with "dry run" in its
 * name could do. `stripe-credits-reconcile` wrote subscription rows and granted credits. The others
 * wrote snapshots and expired purchases.
 *
 * Refusing is the honest minimum, and it is strictly better than the alternative of implementing a
 * half-hearted dry run per route: a `dryRun` that covers three of five write paths reads as
 * supported and is more dangerous than one that is absent.
 *
 * When a route grows real support, delete its call rather than passing `supported: true` — the
 * absence of this guard should mean the route handles it.
 */
import { NextResponse } from "next/server";

export function refuseUnsupportedDryRun(request: Request, jobKey: string): NextResponse | null {
  const asked = new URL(request.url).searchParams.get("dryRun");
  if (asked !== "1" && asked !== "true") return null;
  return NextResponse.json(
    {
      ok: false,
      error: "DRY_RUN_UNSUPPORTED",
      jobKey,
      message: `${jobKey} has no dry-run mode. It was ignoring --dry-run and doing the real work, so it refuses instead. Run it without the flag when you mean it.`,
    },
    { status: 400 },
  );
}
