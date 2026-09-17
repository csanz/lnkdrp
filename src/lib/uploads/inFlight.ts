/**
 * The in-flight upload list the Activity feed draws above its rows, and the rules for folding
 * realtime frames into it.
 *
 * Pure on purpose: the page owns the socket and the fetch, this owns what the list should look
 * like afterwards. The awkward cases are all here — frames arriving out of order (a `rendering`
 * write and a `summarizing` write can cross), a frame for an upload the page never loaded (the
 * document was created seconds ago in another tab, or by an agent), and the moment an upload
 * stops being in flight and should settle rather than vanish mid-animation.
 */
import { isTerminalUploadStatus } from "@/lib/uploads/progress";

export type InFlightUpload = {
  id: string;
  docId: string | null;
  docTitle: string | null;
  /** 0–100. */
  percent: number;
  /** Human text, e.g. "rendering page 3 of 9". */
  stage: string;
  /** Upload status: uploading | uploaded | processing | completed | failed. */
  status: string;
  version: number | null;
  updatedAt: string | null;
  /** When it reached a terminal status, in ms — the settle timer reads this. */
  finishedAt: number | null;
};

/** The `upload` realtime frame's payload (see `realtime/server.ts`). */
export type UploadFramePayload = {
  id: string;
  docId?: string | null;
  docTitle?: string | null;
  percent?: number | null;
  stage?: string | null;
  status?: string | null;
  version?: number | null;
};

/** How long a finished entry stays on screen before it is dropped, so the bar is seen to fill. */
export const UPLOAD_SETTLE_MS = 6000;

/** 0–100, whole numbers, and tolerant of whatever the wire actually carried. */
function clampPercent(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}

/**
 * Fold one frame into the list.
 *
 * Ordering rule: the bar only ever moves forward. A late frame from an earlier stage would
 * otherwise drag it backwards, which reads as the upload going wrong. A terminal status is the
 * exception — `completed` pins it to 100 and `failed` stops it wherever it was, whenever they
 * arrive.
 *
 * An id the list has never seen is added at the top, so an upload started elsewhere shows up the
 * moment it makes noise instead of waiting for a reload.
 */
export function mergeUploadFrame(
  list: InFlightUpload[],
  frame: UploadFramePayload,
  opts?: { now?: number },
): InFlightUpload[] {
  const id = String(frame?.id ?? "").trim();
  if (!id) return list;
  const now = typeof opts?.now === "number" ? opts.now : Date.now();
  const status = typeof frame.status === "string" && frame.status ? frame.status : null;
  const terminal = isTerminalUploadStatus(status);
  const index = list.findIndex((u) => u.id === id);

  if (index === -1) {
    // A finished upload nobody was watching is not news; only add rows that still have something
    // to show. (A `completed` frame for an unknown id is exactly what a fast, already-cached
    // upload produces on a page that just mounted.)
    if (terminal) return list;
    const added: InFlightUpload = {
      id,
      docId: frame.docId ? String(frame.docId) : null,
      docTitle: typeof frame.docTitle === "string" && frame.docTitle.trim() ? frame.docTitle.trim() : null,
      percent: clampPercent(frame.percent),
      stage: typeof frame.stage === "string" && frame.stage ? frame.stage : "preparing",
      status: status ?? "processing",
      version: Number.isFinite(frame.version) ? Number(frame.version) : null,
      updatedAt: new Date(now).toISOString(),
      finishedAt: null,
    };
    return [added, ...list];
  }

  const current = list[index] as InFlightUpload;
  const incoming = clampPercent(frame.percent);
  const forward = terminal || incoming >= current.percent;
  const next: InFlightUpload = {
    ...current,
    docId: frame.docId ? String(frame.docId) : current.docId,
    docTitle:
      typeof frame.docTitle === "string" && frame.docTitle.trim() ? frame.docTitle.trim() : current.docTitle,
    percent: status === "completed" ? 100 : forward ? incoming : current.percent,
    stage: forward && typeof frame.stage === "string" && frame.stage ? frame.stage : current.stage,
    status: status ?? current.status,
    version: Number.isFinite(frame.version) ? Number(frame.version) : current.version,
    updatedAt: forward ? new Date(now).toISOString() : current.updatedAt,
    finishedAt: terminal ? (current.finishedAt ?? now) : current.finishedAt,
  };
  const out = list.slice();
  out[index] = next;
  return out;
}

/**
 * The document flipped to `ready` (or `failed`) — settle every entry still running on it.
 *
 * The `doc` frame is often what arrives first: the process job writes the document last, and its
 * change stream has no throttle in front of it. Without this the bar could sit at 96% under a
 * document that is already open and readable.
 */
export function markDocFinished(
  list: InFlightUpload[],
  docId: string,
  docStatus: string | null,
  opts?: { now?: number },
): InFlightUpload[] {
  const id = String(docId ?? "").trim();
  if (!id) return list;
  if (docStatus !== "ready" && docStatus !== "failed") return list;
  const now = typeof opts?.now === "number" ? opts.now : Date.now();
  let changed = false;
  const out = list.map((u) => {
    if (u.docId !== id || isTerminalUploadStatus(u.status)) return u;
    changed = true;
    return {
      ...u,
      percent: docStatus === "ready" ? 100 : u.percent,
      stage: docStatus === "ready" ? "ready" : "failed",
      status: docStatus === "ready" ? "completed" : "failed",
      finishedAt: now,
    };
  });
  return changed ? out : list;
}

/** Drop entries that finished more than `settleMs` ago; everything else stays put. */
export function pruneUploads(list: InFlightUpload[], opts?: { now?: number; settleMs?: number }): InFlightUpload[] {
  const now = typeof opts?.now === "number" ? opts.now : Date.now();
  const settleMs = typeof opts?.settleMs === "number" ? opts.settleMs : UPLOAD_SETTLE_MS;
  const out = list.filter((u) => u.finishedAt === null || now - u.finishedAt < settleMs);
  return out.length === list.length ? list : out;
}

/**
 * Replace the list with what the server says is in flight, keeping anything the socket already
 * showed us. A fetch is a snapshot taken before the frames that have landed since; letting it win
 * outright would rewind bars that have already moved on, and drop rows the fetch never saw.
 */
export function mergeInFlightSnapshot(
  list: InFlightUpload[],
  snapshot: InFlightUpload[],
  opts?: { now?: number },
): InFlightUpload[] {
  let out = list;
  for (const row of snapshot) {
    out = mergeUploadFrame(
      out,
      {
        id: row.id,
        docId: row.docId,
        docTitle: row.docTitle,
        percent: row.percent,
        stage: row.stage,
        status: row.status,
        version: row.version,
      },
      opts,
    );
  }
  return out;
}
