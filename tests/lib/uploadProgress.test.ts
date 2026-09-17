/**
 * Live upload progress (metis mt_sr5nuMA_VF): the stage → percent table, the render band's
 * sub-position, the throttle decision, and the reducer the Activity feed folds realtime frames
 * into.
 *
 * The three things worth pinning down here are the three that are invisible when they go wrong: a
 * bar that runs backwards (out-of-order frames), a bar that never finishes (a last write eaten by
 * the throttle), and a render loop that writes once per page on a long deck.
 *
 * Expectations are derived from the rules, not copied from a run.
 */
import { describe, expect, test } from "vitest";

import {
  IN_FLIGHT_UPLOAD_STATUSES,
  isTerminalUploadStatus,
  PROGRESS_MIN_INTERVAL_MS,
  RENDER_PERCENT_END,
  RENDER_PERCENT_START,
  shouldWriteProgress,
  uploadProgressFor,
  UPLOAD_STAGE_PERCENT,
  type UploadStageKey,
} from "@/lib/uploads/progress";
import {
  markDocFinished,
  mergeInFlightSnapshot,
  mergeUploadFrame,
  pruneUploads,
  UPLOAD_SETTLE_MS,
  type InFlightUpload,
} from "@/lib/uploads/inFlight";

/** The pipeline's order, which is also the order the percents must not decrease in. */
const PIPELINE_ORDER: UploadStageKey[] = [
  "created",
  "receiving",
  "storing",
  "stored",
  "fetching",
  "preview",
  "extracting",
  "rendering",
  "comparing",
  "summarizing",
  "finishing",
  "ready",
];

/** An in-flight row with sane defaults, so each test only states the field it is about. */
function inFlight(over: Partial<InFlightUpload> & { id: string }): InFlightUpload {
  return {
    docId: "doc1",
    docTitle: "Seed deck",
    percent: 0,
    stage: "preparing",
    status: "processing",
    version: 1,
    updatedAt: null,
    finishedAt: null,
    ...over,
  };
}

describe("stage → percent", () => {
  test("every stage of the pipeline moves the bar forward, and only forward", () => {
    let previous = -1;
    for (const stage of PIPELINE_ORDER) {
      const { percent } = uploadProgressFor({ stage });
      expect(percent, `${stage} must not go backwards`).toBeGreaterThan(previous);
      previous = percent;
    }
  });

  test("the run starts above zero and ends at exactly 100", () => {
    expect(uploadProgressFor({ stage: "created" }).percent).toBeGreaterThan(0);
    expect(uploadProgressFor({ stage: "ready" }).percent).toBe(100);
  });

  test("downloading and receiving are the same point, reached by different transports", () => {
    // import-url pulls the file, import-bytes is handed it; from the owner's side it is one wait.
    expect(UPLOAD_STAGE_PERCENT.downloading).toBe(UPLOAD_STAGE_PERCENT.receiving);
  });

  test("the render loop walks its band from start to end as pages land", () => {
    const pages = 9;
    const first = uploadProgressFor({ stage: "rendering", page: 1, pages });
    const mid = uploadProgressFor({ stage: "rendering", page: 5, pages });
    const last = uploadProgressFor({ stage: "rendering", page: 9, pages });

    expect(first.percent).toBeGreaterThan(RENDER_PERCENT_START);
    expect(first.percent).toBeLessThan(mid.percent);
    expect(mid.percent).toBeLessThan(last.percent);
    expect(last.percent).toBe(RENDER_PERCENT_END);
    // A nine-page deck must visibly move several times, which is the whole point of the band.
    expect(last.percent - first.percent).toBeGreaterThanOrEqual(8);
  });

  test("the render stage names the page a person is waiting on", () => {
    expect(uploadProgressFor({ stage: "rendering", page: 3, pages: 9 }).stage).toBe("rendering page 3 of 9");
  });

  test("a render with no page count sits at the band's start rather than inventing a fraction", () => {
    const unknown = uploadProgressFor({ stage: "rendering", page: 0, pages: 0 });
    expect(unknown.percent).toBe(RENDER_PERCENT_START);
    expect(unknown.stage).toBe("rendering pages");
  });

  test("the render band never leaves its lane, whatever the page numbers say", () => {
    // A page count that disagrees with the loop (a retry, a fallback numPages) must not push the
    // bar past the stage that follows it.
    for (const [page, pages] of [
      [12, 9],
      [-4, 9],
      [1, 1],
    ] as const) {
      const { percent } = uploadProgressFor({ stage: "rendering", page, pages });
      expect(percent).toBeGreaterThanOrEqual(RENDER_PERCENT_START);
      expect(percent).toBeLessThanOrEqual(RENDER_PERCENT_END);
    }
    expect(RENDER_PERCENT_END).toBeLessThan(UPLOAD_STAGE_PERCENT.comparing);
  });

  test("a failure keeps the bar where it stopped instead of snapping back", () => {
    expect(uploadProgressFor({ stage: "failed", percent: 68 })).toMatchObject({ percent: 68, stage: "failed" });
    // With nothing to pin it to there is no honest number, and 0 is the safe one.
    expect(uploadProgressFor({ stage: "failed" }).percent).toBe(0);
  });

  test("percents are clamped and rounded to whole numbers, because they are rendered as text", () => {
    expect(uploadProgressFor({ stage: "ready", percent: 140 }).percent).toBe(100);
    expect(uploadProgressFor({ stage: "ready", percent: -3 }).percent).toBe(0);
    expect(uploadProgressFor({ stage: "ready", percent: 41.6 }).percent).toBe(42);
    expect(uploadProgressFor({ stage: "ready", percent: Number.NaN }).percent).toBe(100);
  });

  test("terminal statuses are the two that end a run", () => {
    expect(isTerminalUploadStatus("completed")).toBe(true);
    expect(isTerminalUploadStatus("failed")).toBe(true);
    for (const s of IN_FLIGHT_UPLOAD_STATUSES) expect(isTerminalUploadStatus(s)).toBe(false);
    expect(isTerminalUploadStatus(null)).toBe(false);
  });
});

describe("throttle", () => {
  test("the first write always goes through — it is what makes the bar appear", () => {
    expect(shouldWriteProgress({ percent: 22, lastPercent: null, lastWriteAt: null, now: 1_000 })).toBe(true);
  });

  test("a forced write ignores the interval — it is what makes the bar finish", () => {
    expect(
      shouldWriteProgress({ percent: 100, lastPercent: 96, lastWriteAt: 1_000, now: 1_050, force: true }),
    ).toBe(true);
  });

  test("a repeat of the same percent is never written", () => {
    expect(
      shouldWriteProgress({ percent: 40, lastPercent: 40, lastWriteAt: 1_000, now: 1_000_000 }),
    ).toBe(false);
  });

  test("writes inside the interval are dropped, and the one after it is not", () => {
    const base = { percent: 44, lastPercent: 40, lastWriteAt: 1_000 };
    expect(shouldWriteProgress({ ...base, now: 1_000 + PROGRESS_MIN_INTERVAL_MS - 1 })).toBe(false);
    expect(shouldWriteProgress({ ...base, now: 1_000 + PROGRESS_MIN_INTERVAL_MS })).toBe(true);
  });

  test("a fifty-page render writes a handful of times, not fifty", () => {
    // Pages at 120ms each: the loop calls on every page, the throttle decides.
    const pages = 50;
    let lastPercent: number | null = null;
    let lastWriteAt: number | null = null;
    let writes = 0;
    for (let page = 1; page <= pages; page++) {
      const now = page * 120;
      const { percent } = uploadProgressFor({ stage: "rendering", page, pages });
      if (shouldWriteProgress({ percent, lastPercent, lastWriteAt, now })) {
        writes += 1;
        lastPercent = percent;
        lastWriteAt = now;
      }
    }
    expect(writes).toBeLessThan(pages / 2);
    // …but it must still move enough to read as progress rather than a frozen bar.
    expect(writes).toBeGreaterThanOrEqual(5);
  });
});

describe("the feed's in-flight reducer", () => {
  test("a frame for an upload the page has never seen adds it at the top", () => {
    const out = mergeUploadFrame([inFlight({ id: "a", percent: 50 })], {
      id: "b",
      docId: "doc2",
      percent: 22,
      stage: "fetching the file",
      status: "processing",
    });
    expect(out.map((u) => u.id)).toEqual(["b", "a"]);
    expect(out[0]).toMatchObject({ docId: "doc2", percent: 22, stage: "fetching the file" });
    // No title on the wire; the page re-fetches the snapshot to learn it.
    expect(out[0]?.docTitle).toBeNull();
  });

  test("an unknown upload that is already over is not resurrected as a bar", () => {
    const out = mergeUploadFrame([], { id: "b", percent: 100, status: "completed" });
    expect(out).toEqual([]);
  });

  test("an out-of-order frame never drags the bar backwards", () => {
    const list = [inFlight({ id: "a", percent: 88, stage: "writing the summary" })];
    const out = mergeUploadFrame(list, { id: "a", percent: 54, stage: "rendering page 4 of 9", status: "processing" });
    expect(out[0]).toMatchObject({ percent: 88, stage: "writing the summary" });
  });

  test("a terminal frame lands whenever it arrives, even behind the current percent", () => {
    const list = [inFlight({ id: "a", percent: 96 })];
    const done = mergeUploadFrame(list, { id: "a", percent: 100, status: "completed" }, { now: 5_000 });
    expect(done[0]).toMatchObject({ percent: 100, status: "completed", finishedAt: 5_000 });

    const failed = mergeUploadFrame(list, { id: "a", percent: 40, status: "failed" }, { now: 5_000 });
    // The bar stops where the run stopped; it does not rewind to the failing stage's percent.
    expect(failed[0]).toMatchObject({ percent: 40, status: "failed", finishedAt: 5_000 });
  });

  test("a second terminal frame does not restart the settle clock", () => {
    const first = mergeUploadFrame([inFlight({ id: "a", percent: 96 })], { id: "a", percent: 100, status: "completed" }, { now: 1_000 });
    const second = mergeUploadFrame(first, { id: "a", percent: 100, status: "completed" }, { now: 9_000 });
    expect(second[0]?.finishedAt).toBe(1_000);
  });

  test("a frame with no id changes nothing", () => {
    const list = [inFlight({ id: "a" })];
    expect(mergeUploadFrame(list, { id: "" })).toBe(list);
  });

  test("the document flipping to ready settles every bar still running on it", () => {
    const list = [inFlight({ id: "a", docId: "doc1", percent: 96 }), inFlight({ id: "b", docId: "doc2", percent: 40 })];
    const out = markDocFinished(list, "doc1", "ready", { now: 7_000 });
    expect(out[0]).toMatchObject({ percent: 100, status: "completed", stage: "ready", finishedAt: 7_000 });
    // Another document's upload is untouched.
    expect(out[1]).toMatchObject({ percent: 40, status: "processing" });
  });

  test("a document flipping to failed stops its bar where it was", () => {
    const out = markDocFinished([inFlight({ id: "a", percent: 34 })], "doc1", "failed", { now: 7_000 });
    expect(out[0]).toMatchObject({ percent: 34, status: "failed", stage: "failed" });
  });

  test("a document status that is not an ending is ignored, identity and all", () => {
    const list = [inFlight({ id: "a" })];
    expect(markDocFinished(list, "doc1", "preparing")).toBe(list);
    expect(markDocFinished(list, "", "ready")).toBe(list);
  });

  test("finished entries hold their filled bar for a beat, then go", () => {
    const list = [inFlight({ id: "a", status: "completed", percent: 100, finishedAt: 1_000 }), inFlight({ id: "b" })];
    expect(pruneUploads(list, { now: 1_000 + UPLOAD_SETTLE_MS - 1 })).toHaveLength(2);
    expect(pruneUploads(list, { now: 1_000 + UPLOAD_SETTLE_MS }).map((u) => u.id)).toEqual(["b"]);
  });

  test("pruning nothing keeps the same array, so the page does not re-render every second", () => {
    const list = [inFlight({ id: "a" })];
    expect(pruneUploads(list, { now: 10_000 })).toBe(list);
  });

  test("a snapshot fetched mid-flight fills in titles without rewinding what the socket showed", () => {
    // The page saw frames first (no title, already at 54%); the fetch is an older picture.
    const live = [inFlight({ id: "a", docTitle: null, percent: 54, stage: "rendering page 4 of 9" })];
    const out = mergeInFlightSnapshot(live, [
      inFlight({ id: "a", docTitle: "Series A deck", percent: 28, stage: "making the preview image" }),
      inFlight({ id: "b", docTitle: "Memo", percent: 8, stage: "downloading the file" }),
    ]);
    expect(out.find((u) => u.id === "a")).toMatchObject({
      docTitle: "Series A deck",
      percent: 54,
      stage: "rendering page 4 of 9",
    });
    // And a row only the server knew about joins the list.
    expect(out.find((u) => u.id === "b")).toMatchObject({ docTitle: "Memo", percent: 8 });
  });
});
