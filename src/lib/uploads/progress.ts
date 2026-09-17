/**
 * Upload progress: the stage → percent table, and the decision of when a progress write is worth
 * making.
 *
 * An upload is the one thing in lnkdrp that takes real time — fetching the file, rendering every
 * page to an image, extracting the text, then two AI passes — and until now the only thing anyone
 * could see was "preparing" until it was over. A nine-page deck coming in over MCP is a minute of
 * silence. So the pipeline records where it is on the Upload row (`progress.percent`,
 * `progress.stage`), the realtime server turns each of those writes into an `upload` frame, and
 * the Activity feed draws a bar that moves.
 *
 * Deliberately pure and free of mongoose: the routes write through `progressWriter.ts`, the
 * browser reads the same labels back off the wire, and both halves are testable without a
 * database. The stage strings are written for a person or an agent to read aloud, not for code to
 * branch on — the machine-readable half is the stage KEY plus the percent.
 */

/**
 * Where a run can be. The order here is the order the pipeline moves through them:
 *
 * - `created`     the Upload row exists; no bytes yet (`POST /api/uploads`)
 * - `receiving`   bytes are arriving inline (`import-bytes`)
 * - `downloading` the file is being pulled from a URL (`import-url`)
 * - `storing`     the bytes are going into blob storage
 * - `stored`      blob storage has the file; processing has not started
 * - `fetching`    the process job is reading the file back out of blob storage
 * - `preview`     rendering the cover image
 * - `extracting`  pulling the text out of the PDF
 * - `rendering`   the per-page image loop — the long part, and the only stage with a sub-position
 * - `comparing`   the AI compare against the previous version (replacements only)
 * - `summarizing` the AI summary
 * - `finishing`   writing the results back to the upload and the document
 * - `ready`       the document flipped to `ready`
 * - `failed`      the run gave up
 */
export type UploadStageKey =
  | "created"
  | "receiving"
  | "downloading"
  | "storing"
  | "stored"
  | "fetching"
  | "preview"
  | "extracting"
  | "rendering"
  | "comparing"
  | "summarizing"
  | "finishing"
  | "ready"
  | "failed";

/**
 * The page-render loop owns this band. It is the widest one because it is the stage that actually
 * takes the time: everything else is a handful of seconds, a fifty-page deck is minutes.
 */
export const RENDER_PERCENT_START = 40;
export const RENDER_PERCENT_END = 78;

/**
 * Percent at the moment a stage BEGINS. `rendering` is the band start; use `uploadProgressFor`
 * with `page`/`pages` to get a position inside it.
 *
 * `failed` has no percent of its own — a failure keeps whatever the bar had reached, because
 * "it died at 68%" is more useful than a bar that snaps back to zero.
 */
export const UPLOAD_STAGE_PERCENT: Record<Exclude<UploadStageKey, "failed">, number> = {
  created: 2,
  receiving: 8,
  downloading: 8,
  storing: 14,
  stored: 18,
  fetching: 22,
  preview: 28,
  extracting: 34,
  rendering: RENDER_PERCENT_START,
  comparing: 82,
  summarizing: 88,
  finishing: 96,
  ready: 100,
};

/** Human-readable stage text, the string an owner reads on the bar and an agent can repeat back. */
const UPLOAD_STAGE_LABEL: Record<UploadStageKey, string> = {
  created: "waiting for the file",
  receiving: "receiving the file",
  downloading: "downloading the file",
  storing: "storing the file",
  stored: "file stored",
  fetching: "fetching the file",
  preview: "making the preview image",
  extracting: "extracting text",
  rendering: "rendering pages",
  comparing: "comparing with the previous version",
  summarizing: "writing the summary",
  finishing: "finishing up",
  ready: "ready",
  failed: "failed",
};

export type UploadProgress = { percent: number; stage: string; stageKey: UploadStageKey };

/** 0–100, whole numbers: the value is rendered as text, so it must not carry a fraction. */
function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * The percent and the sentence for a stage.
 *
 * `page`/`pages` only mean anything for `rendering`, where they place the run inside the render
 * band and make the stage read "rendering page 3 of 9". A render with an unknown page count sits
 * at the band's start rather than pretending to a fraction it does not have.
 *
 * `percent` overrides the table — used by `failed`, which keeps the bar where it stopped.
 */
export function uploadProgressFor(input: {
  stage: UploadStageKey;
  page?: number | null;
  pages?: number | null;
  percent?: number | null;
}): UploadProgress {
  const stage = input.stage;
  const pages = Number.isFinite(input.pages) ? Math.floor(Number(input.pages)) : 0;
  const page = Number.isFinite(input.page) ? Math.floor(Number(input.page)) : 0;

  let percent: number;
  if (typeof input.percent === "number" && Number.isFinite(input.percent)) {
    percent = clampPercent(input.percent);
  } else if (stage === "failed") {
    percent = 0;
  } else if (stage === "rendering" && pages > 0) {
    const done = Math.max(0, Math.min(pages, page));
    percent = clampPercent(RENDER_PERCENT_START + (done / pages) * (RENDER_PERCENT_END - RENDER_PERCENT_START));
  } else {
    percent = clampPercent(UPLOAD_STAGE_PERCENT[stage]);
  }

  let text = UPLOAD_STAGE_LABEL[stage];
  if (stage === "rendering" && pages > 0) {
    const shown = Math.max(1, Math.min(pages, page || 1));
    text = `rendering page ${shown} of ${pages}`;
  }
  return { percent, stage: text, stageKey: stage };
}

/** Never write progress more often than this, per upload — the render loop would hammer Mongo. */
export const PROGRESS_MIN_INTERVAL_MS = 750;

/**
 * Should this progress update be written?
 *
 * The rule the render loop needs: the first write and the last write always go through (they are
 * what makes a bar appear and what makes it finish), a repeat of the same percent never does, and
 * anything in between waits out `minIntervalMs` since the last write. A nine-page deck then moves
 * several times without a write per page, and a two-hundred-page one does not melt the database.
 */
export function shouldWriteProgress(input: {
  percent: number;
  lastPercent: number | null;
  lastWriteAt: number | null;
  now: number;
  force?: boolean;
  minIntervalMs?: number;
}): boolean {
  if (input.force) return true;
  if (input.lastWriteAt === null || input.lastPercent === null) return true;
  if (input.percent === input.lastPercent) return false;
  const min = typeof input.minIntervalMs === "number" ? input.minIntervalMs : PROGRESS_MIN_INTERVAL_MS;
  return input.now - input.lastWriteAt >= min;
}

/** Upload statuses that mean "still going" — what the in-flight feed and its API select on. */
export const IN_FLIGHT_UPLOAD_STATUSES = ["uploading", "uploaded", "processing"] as const;

/** Whether an upload status means the run is over, either way. */
export function isTerminalUploadStatus(status: string | null | undefined): boolean {
  return status === "completed" || status === "failed";
}
