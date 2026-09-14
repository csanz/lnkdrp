/**
 * Spacing between test steps, so generated traffic reads as activity instead of as a script.
 *
 * A harness that fires every call as fast as the network allows produces data that is obviously
 * synthetic and, worse, unusable for judging the product: twenty activity rows share one timestamp
 * so the feed is a wall with no sequence to read, every view lands in one second so the
 * views-by-day chart is a single spike, and per-page dwell times come out in milliseconds, which
 * makes "time on page" meaningless on exactly the screens you are trying to evaluate.
 *
 * A short randomised gap between steps fixes all of that for the price of a slower run. The gap is
 * randomised rather than fixed because a constant interval is its own tell — real people do not
 * act on a metronome.
 *
 * Default: on. These harnesses are run by hand to look at the result, and that is the case where
 * realism matters. Pass `--fast` in CI, where nobody is looking at the feed.
 *
 * Flags parsed from `process.argv`:
 *   --fast              no pauses at all
 *   --pace <min>-<max>  seconds between steps (default 1.5-5)
 *   --pace <n>          fixed n seconds, no jitter
 */

const DEFAULT_MIN_SECONDS = 1.5;
const DEFAULT_MAX_SECONDS = 5;

function argValue(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return null;
  const v = process.argv[i + 1];
  return typeof v === "string" && !v.startsWith("--") ? v : null;
}

/** The configured gap, resolved once so every step in a run uses the same settings. */
export type Pacing = { enabled: boolean; minMs: number; maxMs: number };

export function resolvePacing(): Pacing {
  if (process.argv.includes("--fast")) return { enabled: false, minMs: 0, maxMs: 0 };
  const raw = argValue("pace");
  if (!raw) return { enabled: true, minMs: DEFAULT_MIN_SECONDS * 1000, maxMs: DEFAULT_MAX_SECONDS * 1000 };
  const [minRaw, maxRaw] = raw.split("-");
  const min = Number(minRaw);
  const max = maxRaw === undefined ? min : Number(maxRaw);
  if (!Number.isFinite(min) || min < 0 || !Number.isFinite(max) || max < min) {
    throw new Error(`--pace expects <seconds> or <min>-<max>, got "${raw}"`);
  }
  return { enabled: max > 0, minMs: min * 1000, maxMs: max * 1000 };
}

/** Describe the pacing for the run header, so a reader knows why it is taking this long. */
export function describePacing(p: Pacing): string {
  if (!p.enabled) return "pacing off (--fast)";
  if (p.minMs === p.maxMs) return `pacing ${(p.minMs / 1000).toFixed(1)}s between steps`;
  return `pacing ${(p.minMs / 1000).toFixed(1)}-${(p.maxMs / 1000).toFixed(1)}s between steps`;
}

/** Wait a randomised gap. A no-op when pacing is off, so callers need no branch. */
export async function pause(p: Pacing): Promise<void> {
  if (!p.enabled) return;
  const ms = Math.round(p.minMs + Math.random() * (p.maxMs - p.minMs));
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A longer gap, for the seam between one *actor* and the next — a different person picking the
 * link up, or the same person coming back later. Steps inside one sitting belong seconds apart;
 * two sittings that land seconds apart are what makes a return visit look fake.
 */
export async function pauseBetweenActors(p: Pacing, multiplier = 4): Promise<void> {
  if (!p.enabled) return;
  const base = p.minMs + Math.random() * (p.maxMs - p.minMs);
  await new Promise((resolve) => setTimeout(resolve, Math.round(base * multiplier)));
}
