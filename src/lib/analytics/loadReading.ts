/**
 * Loads everything the reading analytics endpoints need for one document and hands it to the pure
 * builders in `src/lib/analytics/reading`. No cache: every call reads the rows fresh.
 */
import { Types } from "mongoose";

import { ShareLinkModel } from "@/lib/models/ShareLink";
import { ShareViewModel } from "@/lib/models/ShareView";
import { ShareVisitModel } from "@/lib/models/ShareVisit";
import { UploadModel } from "@/lib/models/Upload";
import {
  LAST_ACTIVITY_EXPR,
  LINK_VIEWER_KEY_EXPR,
  RECIPIENT_ONLY_MATCH,
  activityWindowMatch,
  windowStartUtc,
} from "@/lib/analytics/shareViewAggregates";
import {
  MAX_VISITS_LOADED,
  buildReadingCore,
  type AllTimePerson,
  type DocPagesInput,
  type PersonIdParts,
  type LinkInput,
  type RawPageEvent,
  type ReadingCore,
  type ViewRowInput,
  type VisitInput,
} from "@/lib/analytics/reading";

/** An ObjectId or string as a string; null when missing. */
function idString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s ? s : null;
}

/** A non-empty string, else null. */
function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

/** A finite number, else 0. */
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** A valid Date, else null. */
function dateOrNull(v: unknown): Date | null {
  return v instanceof Date && Number.isFinite(v.getTime()) ? v : null;
}

/** Aggregation expression: 1 when a string field holds more than whitespace, else 0. */
function hasTextExpr(field: string): Record<string, unknown> {
  return {
    $gt: [{ $strLenCP: { $trim: { input: { $cond: [{ $eq: [{ $type: field }, "string"] }, field, ""] } } } }, 0],
  };
}

/** Read links, in-range rows and visits, all-time activity per person key and completed uploads, then build the core. */
export async function loadReadingCore(a: {
  docId: string | Types.ObjectId;
  doc: DocPagesInput;
  days: number;
  now: number;
}): Promise<ReadingCore> {
  const docId = typeof a.docId === "string" ? new Types.ObjectId(a.docId) : a.docId;
  const start = windowStartUtc(a.days, new Date(a.now));

  const [linkDocs, rowDocs, visitDocs, lastOpenedAgg, completedUploads] = await Promise.all([
    ShareLinkModel.find({ docId })
      .select({ shareId: 1, label: 1, isDefault: 1, enabled: 1, expiresAt: 1, archivedAt: 1, createdDate: 1 })
      .lean<Array<Record<string, unknown>>>(),
    ShareViewModel.find({ docId, ...RECIPIENT_ONLY_MATCH, ...activityWindowMatch(start) })
      .select({
        shareId: 1,
        botIdHash: 1,
        viewerUserId: 1,
        viewerName: 1,
        viewerEmail: 1,
        viewerEmailSnapshot: 1,
        createdDate: 1,
        lastViewedAt: 1,
        updatedDate: 1,
        downloads: 1,
      })
      .lean<Array<Record<string, unknown>>>(),
    ShareVisitModel.find({ docId, ...RECIPIENT_ONLY_MATCH, lastEventAt: { $gte: start } })
      .select({
        shareId: 1,
        botIdHash: 1,
        startedAt: 1,
        lastEventAt: 1,
        timeSpentMs: 1,
        pagesSeen: 1,
        pageEvents: 1,
        timingVersion: 1,
      })
      .sort({ lastEventAt: -1 })
      .limit(MAX_VISITS_LOADED)
      .lean<Array<Record<string, unknown>>>(),
    // One all-time pass per person key: link last-opened is the max over its keys, and anonymous
    // numbering ranks keys by first seen so it never depends on the range or link filter.
    ShareViewModel.aggregate([
      { $match: { docId, ...RECIPIENT_ONLY_MATCH } },
      {
        $group: {
          _id: LINK_VIEWER_KEY_EXPR,
          last: { $max: LAST_ACTIVITY_EXPR },
          first: { $min: "$createdDate" },
          named: {
            $max: {
              $cond: [{ $or: [hasTextExpr("$viewerName"), hasTextExpr("$viewerEmail"), hasTextExpr("$viewerEmailSnapshot")] }, 1, 0],
            },
          },
        },
      },
    ]) as Promise<Array<{ _id?: { shareId?: unknown; viewer?: unknown }; last?: unknown; first?: unknown; named?: unknown }>>,
    UploadModel.countDocuments({ docId, status: "completed" }),
  ]);

  const links: LinkInput[] = linkDocs
    .filter((l) => str(l.shareId))
    .map((l) => ({
      shareId: String(l.shareId),
      label: str(l.label) ?? "",
      isDefault: Boolean(l.isDefault),
      enabled: l.enabled !== false,
      expiresAt: dateOrNull(l.expiresAt),
      archivedAt: dateOrNull(l.archivedAt),
      createdDate: dateOrNull(l.createdDate) ?? new Date(0),
    }));

  const rows: ViewRowInput[] = rowDocs
    .filter((r) => str(r.shareId) && str(r.botIdHash))
    .map((r) => ({
      shareId: String(r.shareId),
      botIdHash: String(r.botIdHash),
      viewerUserId: idString(r.viewerUserId),
      viewerName: str(r.viewerName),
      viewerEmail: str(r.viewerEmail),
      viewerEmailSnapshot: str(r.viewerEmailSnapshot),
      createdDate: dateOrNull(r.createdDate) ?? new Date(0),
      lastViewedAt: dateOrNull(r.lastViewedAt),
      updatedDate: dateOrNull(r.updatedDate) ?? dateOrNull(r.createdDate) ?? new Date(0),
      downloads: num(r.downloads),
    }));

  const visits: VisitInput[] = visitDocs
    .filter((v) => str(v.shareId) && str(v.botIdHash))
    .map((v) => {
      const lastEventAt = dateOrNull(v.lastEventAt) ?? new Date(0);
      return {
        visitId: String(v._id),
        shareId: String(v.shareId),
        botIdHash: String(v.botIdHash),
        startedAt: dateOrNull(v.startedAt) ?? lastEventAt,
        lastEventAt,
        timeSpentMs: num(v.timeSpentMs),
        pagesSeen: Array.isArray(v.pagesSeen) ? v.pagesSeen : [],
        pageEvents: (Array.isArray(v.pageEvents) ? v.pageEvents : []).map((e) => {
          const ev = (e ?? {}) as Record<string, unknown>;
          return {
            pageNumber: ev.pageNumber,
            enteredAt: dateOrNull(ev.enteredAt),
            leftAt: dateOrNull(ev.leftAt),
            durationMs: ev.durationMs,
            reason: str(ev.reason),
            toPage: ev.toPage,
          } satisfies RawPageEvent;
        }),
        timingVersion: typeof v.timingVersion === "number" ? v.timingVersion : null,
      };
    });

  const allTimePeople: AllTimePerson[] = [];
  const lastByShareId = new Map<string, number>();
  for (const r of lastOpenedAgg) {
    const shareId = str(r._id?.shareId);
    const viewer = str(r._id?.viewer);
    const last = dateOrNull(r.last);
    if (!shareId || !viewer || !last) continue;
    const lastMs = last.getTime();
    lastByShareId.set(shareId, Math.max(lastByShareId.get(shareId) ?? lastMs, lastMs));
    allTimePeople.push({
      key: `${shareId}|${viewer}`,
      shareId,
      firstMs: dateOrNull(r.first)?.getTime() ?? lastMs,
      lastMs,
      anonymousKey: viewer.startsWith("a:"),
      introduced: r.named === 1,
    });
  }
  const lastOpenedRows = [...lastByShareId].map(([shareId, lastMs]) => ({ shareId, lastMs }));

  return buildReadingCore({
    rows,
    visits,
    links,
    lastOpenedRows,
    allTimePeople,
    doc: a.doc,
    completedUploads,
    now: a.now,
  });
}

/**
 * Who a person id belongs to when they have no activity in the range: the name from their latest
 * ShareView row (else their anonymous number) and their all-time last activity. Null when the doc
 * has never had that person.
 */
export async function loadPersonStub(a: {
  docId: string | Types.ObjectId;
  parts: PersonIdParts;
  core: ReadingCore;
}): Promise<{ name: string; lastSeen: string | null } | null> {
  const key = `${a.parts.shareId}|${a.parts.kind}:${a.parts.id}`;
  const allTime = a.core.allTimeByKey.get(key);
  if (!allTime) return null;
  const docId = typeof a.docId === "string" ? new Types.ObjectId(a.docId) : a.docId;
  const viewerMatch = a.parts.kind === "u" ? { viewerUserId: new Types.ObjectId(a.parts.id) } : { botIdHash: a.parts.id, viewerUserId: null };
  const row = await ShareViewModel.findOne({ docId, shareId: a.parts.shareId, ...RECIPIENT_ONLY_MATCH, ...viewerMatch })
    .sort({ lastViewedAt: -1, updatedDate: -1 })
    .select({ viewerName: 1, viewerEmail: 1, viewerEmailSnapshot: 1 })
    .lean<Record<string, unknown>>();
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const email =
    a.parts.kind === "u"
      ? (text(row?.viewerEmailSnapshot) ?? text(row?.viewerEmail))
      : (text(row?.viewerEmail) ?? text(row?.viewerEmailSnapshot));
  const n = a.core.anonNumberByKey.get(key);
  const name = text(row?.viewerName) ?? email ?? (n !== undefined ? `Anonymous reader ${n}` : "Anonymous reader");
  return { name, lastSeen: new Date(allTime.lastMs).toISOString() };
}
