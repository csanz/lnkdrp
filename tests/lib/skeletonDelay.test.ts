/**
 * The rule behind not flashing a placeholder.
 *
 * A skeleton is a promise that something is coming and will look like this. Two ways it lies: when
 * the answer arrives in eighty milliseconds nobody reads the promise, they see a flicker; and when
 * the answer is "you have nothing yet" the promise was false. The workspace metrics page did both
 * at once — a full dashboard of tiles and charts, replaced a moment later by "No shared documents
 * yet", so a brand-new account watched a dashboard appear and vanish before being told there was
 * never going to be one.
 *
 * The hook itself is three lines of React; what is worth pinning is the timing, and especially the
 * case where the load finishes *just* before the timer fires. Getting that wrong puts a skeleton on
 * screen after the content is already there, which is the flash it exists to prevent.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { DEFAULT_SKELETON_DELAY_MS } from "@/lib/client/useSkeletonDelay";

/**
 * The hook's decision, extracted as a state machine so it can be tested without a renderer.
 *
 * Mirrors `useSkeletonDelay`: a timer starts when loading begins, `show` flips when it fires, and
 * the result is `show && loading` so an answer always wins over a pending timer.
 */
function machine(delayMs: number = DEFAULT_SKELETON_DELAY_MS) {
  let loading = false;
  let show = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clear = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    setLoading(next: boolean) {
      loading = next;
      if (!next) {
        clear();
        show = false;
        return;
      }
      if (show || timer) return;
      timer = setTimeout(() => {
        timer = null;
        show = true;
      }, delayMs);
    },
    get visible() {
      return show && loading;
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("a load that answers quickly", () => {
  test("never shows a placeholder at all", () => {
    const m = machine();
    m.setLoading(true);

    vi.advanceTimersByTime(80);
    expect(m.visible).toBe(false);

    m.setLoading(false);
    // The whole point: the page rendered once, straight into its real state.
    vi.advanceTimersByTime(10_000);
    expect(m.visible).toBe(false);
  });

  test("finishing one tick before the timer does not flash afterwards", () => {
    // The bug this guards: a cancelled load whose timer still fires puts a skeleton on screen
    // *after* the content, which is worse than the flash it was meant to prevent.
    const m = machine();
    m.setLoading(true);

    vi.advanceTimersByTime(DEFAULT_SKELETON_DELAY_MS - 1);
    m.setLoading(false);
    vi.advanceTimersByTime(5);

    expect(m.visible).toBe(false);
  });
});

describe("a load that does not", () => {
  test("shows the placeholder once the delay passes", () => {
    const m = machine();
    m.setLoading(true);

    vi.advanceTimersByTime(DEFAULT_SKELETON_DELAY_MS);
    expect(m.visible).toBe(true);
  });

  test("and hides it the moment the answer lands", () => {
    const m = machine();
    m.setLoading(true);
    vi.advanceTimersByTime(DEFAULT_SKELETON_DELAY_MS);
    expect(m.visible).toBe(true);

    m.setLoading(false);
    expect(m.visible).toBe(false);
  });
});

describe("the delay itself", () => {
  test("is a fifth of a second", () => {
    // Long enough to cover a local request and a warm cache; short enough that nobody waits
    // without seeing anything.
    expect(DEFAULT_SKELETON_DELAY_MS).toBe(200);
  });
});
