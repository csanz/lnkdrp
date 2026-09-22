"use client";

/**
 * Whether a load has gone on long enough to be worth drawing a placeholder for.
 *
 * A skeleton is a promise: it says *something is coming, and it will look like this*. When the
 * answer arrives in eighty milliseconds that promise is kept so fast nobody reads it — they just
 * see a flicker. And when the answer is "you have nothing yet", the promise was false: the
 * workspace metrics page drew a full dashboard of tiles and charts and then replaced it with "No
 * shared documents yet", so a brand-new account watched a dashboard appear and vanish before being
 * told there was never going to be one.
 *
 * So: nothing for the first `delayMs`, then the placeholder if the load is genuinely still running.
 * A fast load renders once, straight into its real state. A slow one still gets feedback within a
 * fifth of a second, which is about where a person starts to wonder whether their click landed.
 *
 * 200ms is the default because it is long enough to cover a local request and a warm cache, and
 * short enough that nobody waits without seeing anything.
 *
 * The blank moment before the delay expires is deliberate and is the point: an empty frame that
 * becomes content reads as fast, while a fake dashboard that becomes an empty state reads as
 * broken.
 */
import { useEffect, useRef, useState } from "react";

export const DEFAULT_SKELETON_DELAY_MS = 200;

export function useSkeletonDelay(loading: boolean, delayMs: number = DEFAULT_SKELETON_DELAY_MS): boolean {
  const [show, setShow] = useState(false);
  // Kept in a ref so the effect can clear a pending timer without listing it as a dependency and
  // re-running itself.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!loading) {
      // Answered. Drop any pending timer so a load that finished at 190ms cannot flash its
      // skeleton at 200ms, after the content is already on screen.
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      setShow(false);
      return;
    }

    // Already showing (a second fetch on a page that was slow once): leave it up rather than
    // blanking and re-announcing, which is worse than a placeholder that simply stays.
    if (show) return;

    timer.current = setTimeout(() => {
      timer.current = null;
      setShow(true);
    }, Math.max(0, delayMs));

    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
    // `show` is read but deliberately not a dependency: including it would restart the timer the
    // moment it flips true.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, delayMs]);

  return show && loading;
}
