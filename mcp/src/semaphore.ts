/**
 * A counting semaphore, for the two things in this process that are expensive per call.
 *
 * Ghostscript is a child process that re-encodes every image in a PDF, and pdfjs parses the whole
 * file in this process's heap. Neither was bounded: every inline upload started its own, so a
 * handful of concurrent `share_pdf` calls with large files could hold several Ghostscript
 * processes and several parsed PDFs at once on a machine with a 512 MB budget (code review
 * 2026-09-23, M16). The semaphore queues the excess instead; a queued call waits, it does not fail.
 */
export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Semaphore limit must be a positive integer");
  }

  /** How many holders are running right now. */
  get running(): number {
    return this.active;
  }

  /** How many callers are queued behind the limit. */
  get queued(): number {
    return this.waiting.length;
  }

  /** Wait for a slot, then hold it until the returned release function is called. */
  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
    } else {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
      // The releaser handed the slot straight to us: `active` was not decremented for it.
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    };
  }

  /** Run `fn` inside a slot; the slot is released however `fn` ends. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
