/**
 * Notification email sender (cron/worker helper).
 *
 * Sends workspace-scoped emails based on `OrgMembership` preferences:
 * - doc update emails (replacement diffs)
 * - request repo ("repo link") notifications (new completed uploads into request repos)
 * - view notifications (a recipient opened a document; see `viewNotifications.ts`)
 *
 * This is designed to be called from:
 * - a Vercel Cron route (`/api/cron/notification-emails`)
 * - a local CLI runner (tsx script) for testing
 */
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { DocChangeModel } from "@/lib/models/DocChange";
import { DocModel } from "@/lib/models/Doc";
import { UploadModel } from "@/lib/models/Upload";
import { ProjectModel } from "@/lib/models/Project";
import { UserModel } from "@/lib/models/User";
import {
  NotificationEmailCursorModel,
  type NotificationEmailCursorKey,
} from "@/lib/models/NotificationEmailCursor";
import { sendTextEmail } from "@/lib/email/sendTextEmail";
import { debugError } from "@/lib/debug";
import { resolveConfiguredSiteUrl } from "@/lib/urls";
import {
  emptyViewNotificationTotals,
  normalizeViewEmailMode,
  runViewNotificationsForOrg,
  type ViewEmailMode,
  type ViewNotificationTotals,
} from "@/lib/notifications/viewNotifications";

type Mode = "off" | "daily" | "immediate";

// Requests (inbound document repositories) are hidden at launch; repo-link-request emails are skipped
// unless NEXT_PUBLIC_FEATURE_REQUESTS=1. Doc-update emails are unaffected.
const FEATURE_REQUESTS_ENABLED = process.env.NEXT_PUBLIC_FEATURE_REQUESTS === "1";

/** Memberships fetched per query while scanning. */
const MEMBERSHIP_PAGE_SIZE = 1000;
/** Default and ceiling for `limitMembers` (total memberships per run). */
const DEFAULT_LIMIT_MEMBERS = 50_000;
const MAX_LIMIT_MEMBERS = 200_000;

export type SendNotificationEmailsParams = {
  /** When true, don't send; just compute what would be sent. */
  dryRun?: boolean;
  /** Optional: restrict to a single workspace/org. */
  workspaceId?: string | null;
  /** Optional: restrict to a single user (membership.userId). */
  userId?: string | null;
  /**
   * Max memberships processed per run (safety bound; default 50,000). Memberships are scanned in
   * `_id` order in pages, so every member is reached below this bound; above it the run reports
   * `membersTruncated: true`.
   */
  limitMembers?: number;
  /** Max events sent per member per category per run. */
  limitEventsPerMember?: number;
  /**
   * Max source events fetched per org per category per run (doc updates and request uploads). View
   * emails load their whole window in pages instead, with their own safety cap.
   */
  limitEventsPerOrg?: number;
  /** Default lookback when a cursor is missing. */
  defaultLookbackDays?: number;
  /** Force digest send even if it's not end-of-day UTC. */
  forceDigest?: boolean;
  /** Override "now" for deterministic testing. */
  now?: Date;
};

export type SendNotificationEmailsResult = {
  ok: true;
  now: string;
  dryRun: boolean;
  workspacesProcessed: number;
  membersProcessed: number;
  /** True when the membership scan stopped at `limitMembers`; later members got no email this run. */
  membersTruncated: boolean;
  /**
   * Total recipient sends that threw. Each failure is logged and the affected
   * user's cursor is NOT advanced, so the events are retried on the next run.
   */
  sendFailures: number;
  docUpdate: {
    immediate: { members: number; emails: number; events: number; failed: number };
    daily: { members: number; emails: number; events: number; failed: number; sentTodayUtc: boolean };
  };
  repoLinkRequests: {
    immediate: { members: number; emails: number; events: number; failed: number };
    daily: { members: number; emails: number; events: number; failed: number; sentTodayUtc: boolean };
  };
  /**
   * View notifications (`share_views` cursor). `events` counts new viewers emailed, `daily.returns`
   * returning readers in digests; `off.members` had their cursor moved to now; `cursorsInitialized`
   * were seen for the first time (cursor created at now, nothing sent).
   */
  views: ViewNotificationTotals;
};

function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function asPositiveInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i >= 1 ? i : null;
}

function isValidObjectIdString(id: string | null | undefined): id is string {
  return Boolean(id) && Types.ObjectId.isValid(String(id));
}

/** Where email links point when no site URL is configured outside production (`next dev -p 3001`). */
export const LOCAL_DEV_EMAIL_BASE_URL = "http://localhost:3001";

/**
 * Absolute base for every link in a notification email, without a trailing slash.
 *
 * `NEXT_PUBLIC_SITE_URL`, then `NEXT_PUBLIC_APP_URL`, `NEXTAUTH_URL` and `VERCEL_URL` (the same order
 * as `resolveConfiguredSiteUrl`); outside production, the local dev server. Empty only in production
 * with none of them set: a relative link does nothing in a mail client, so the view block refuses to
 * send in that case (see `runViewNotificationsForOrg`) and the other blocks keep their old relative
 * links.
 */
export function publicBaseUrl(): string {
  const configured = resolveConfiguredSiteUrl();
  if (configured) return configured.toString().replace(/\/+$/, "");
  return process.env.NODE_ENV === "production" ? "" : LOCAL_DEV_EMAIL_BASE_URL;
}

function buildDocUrl(docId: string): string {
  const base = publicBaseUrl();
  return base ? `${base}/doc/${encodeURIComponent(docId)}` : `/doc/${encodeURIComponent(docId)}`;
}

function buildDocHistoryUrl(docId: string): string {
  const base = publicBaseUrl();
  return base ? `${base}/doc/${encodeURIComponent(docId)}/history` : `/doc/${encodeURIComponent(docId)}/history`;
}

function buildRequestsUrl(): string {
  const base = publicBaseUrl();
  return base ? `${base}/requests` : "/requests";
}

function shouldSendDailyUtc(now: Date, force: boolean): boolean {
  if (force) return true;
  // "End of day" is currently interpreted as end-of-day UTC.
  // (We can later honor per-workspace/per-user timezones when persisted.)
  return now.getUTCHours() >= 23;
}

async function getRecipientEmail(userId: string): Promise<{ email: string | null; name: string | null }> {
  const u = await UserModel.findOne({ _id: new Types.ObjectId(userId), isActive: { $ne: false } })
    .select({ email: 1, name: 1 })
    .lean();
  const email = typeof (u as any)?.email === "string" ? String((u as any).email).trim() : "";
  const name = typeof (u as any)?.name === "string" ? String((u as any).name).trim() : "";
  return { email: email || null, name: name || null };
}

async function upsertCursor(params: {
  orgId: Types.ObjectId;
  userId: Types.ObjectId;
  key: NotificationEmailCursorKey;
  /** Each field is set only when given; `returnsNotifiedAt` is used by `share_views` only. */
  lastNotifiedAt?: Date | null;
  returnsNotifiedAt?: Date | null;
  lastDigestDay?: string | null;
}) {
  const set: Record<string, unknown> = {};
  if (typeof params.lastNotifiedAt !== "undefined") set.lastNotifiedAt = params.lastNotifiedAt;
  if (typeof params.returnsNotifiedAt !== "undefined") set.returnsNotifiedAt = params.returnsNotifiedAt;
  if (typeof params.lastDigestDay !== "undefined") set.lastDigestDay = params.lastDigestDay;
  if (!Object.keys(set).length) return;
  await NotificationEmailCursorModel.updateOne(
    { orgId: params.orgId, userId: params.userId, key: params.key },
    { $set: set, $setOnInsert: { orgId: params.orgId, userId: params.userId, key: params.key } },
    { upsert: true },
  );
}

/**
 * Send one recipient email, isolating failures.
 *
 * Returns `true` on success (or dry run), `false` when the send threw. A failure
 * is logged via `debugError` and must NOT advance the recipient's cursor, so the
 * same events are retried on the next run instead of being silently dropped.
 */
async function trySendEmail(params: {
  dryRun: boolean;
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Extra mail headers, e.g. RFC 8058 one-click unsubscribe on view emails. */
  headers?: Record<string, string>;
  context: { orgId: string; userId: string; key: NotificationEmailCursorKey; mode: Mode };
}): Promise<boolean> {
  if (params.dryRun) return true;
  try {
    await sendTextEmail({
      to: params.to,
      subject: params.subject,
      text: params.text,
      ...(params.html ? { html: params.html } : {}),
      ...(params.headers ? { headers: params.headers } : {}),
    });
    return true;
  } catch (err) {
    debugError(1, "[notification-emails] send failed", {
      ...params.context,
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export async function sendNotificationEmails(
  params: SendNotificationEmailsParams = {},
): Promise<SendNotificationEmailsResult> {
  const now = params.now ?? new Date();
  const dryRun = Boolean(params.dryRun);
  const limitMembers = Math.min(MAX_LIMIT_MEMBERS, asPositiveInt(params.limitMembers) ?? DEFAULT_LIMIT_MEMBERS);
  const limitEventsPerMember = Math.min(200, asPositiveInt(params.limitEventsPerMember) ?? 20);
  const limitEventsPerOrg = Math.min(5_000, asPositiveInt(params.limitEventsPerOrg) ?? 500);
  const defaultLookbackDays = Math.min(90, asPositiveInt(params.defaultLookbackDays) ?? 7);
  const forceDigest = Boolean(params.forceDigest);

  const workspaceId = params.workspaceId?.trim() || null;
  const userId = params.userId?.trim() || null;
  if (workspaceId && !Types.ObjectId.isValid(workspaceId)) throw new Error("Invalid workspaceId");
  if (userId && !Types.ObjectId.isValid(userId)) throw new Error("Invalid userId");

  await connectMongo();

  // Every live membership is scanned, including ones with all three kinds off: a view-emails `off`
  // member still needs its `share_views` cursor moved to now each run, or turning view emails back
  // on would email everything since it was turned off. Each block filters by its own mode.
  const membershipFilter: Record<string, unknown> = {
    isDeleted: { $ne: true },
    ...(workspaceId ? { orgId: new Types.ObjectId(workspaceId) } : {}),
    ...(userId ? { userId: new Types.ObjectId(userId) } : {}),
  };

  // Paged by `_id` (the default index) so every live membership is reached on every run, not an
  // arbitrary unsorted subset. `limitMembers` is a safety bound; hitting it is reported as
  // `membersTruncated` and logged rather than silently skipping members.
  const memberships: unknown[] = [];
  let membersTruncated = false;
  let lastMembershipId: unknown = null;
  for (;;) {
    const want = Math.min(MEMBERSHIP_PAGE_SIZE, limitMembers + 1 - memberships.length);
    if (want <= 0) break;
    const page = (await OrgMembershipModel.find({
      ...membershipFilter,
      ...(lastMembershipId ? { _id: { $gt: lastMembershipId } } : {}),
    })
      .sort({ _id: 1 })
      .select({ _id: 1, orgId: 1, userId: 1, docUpdateEmailMode: 1, repoLinkRequestEmailMode: 1, viewEmailMode: 1 })
      .limit(want)
      .lean()) as Array<{ _id?: unknown }>;
    memberships.push(...page);
    if (page.length < want) break;
    lastMembershipId = page[page.length - 1]?._id ?? null;
    if (!lastMembershipId) break;
  }
  if (memberships.length > limitMembers) {
    memberships.length = limitMembers;
    membersTruncated = true;
    debugError(1, "[notification-emails] membership scan hit limitMembers; later members were not processed", {
      limitMembers,
    });
  }

  // Group memberships by org for efficient source-event queries.
  const byOrg = new Map<
    string,
    Array<{ membershipId: string; orgId: string; userId: string; docMode: Mode; repoMode: Mode; viewMode: ViewEmailMode }>
  >();
  for (const m of memberships as any[]) {
    const orgIdStr = m?.orgId ? String(m.orgId) : "";
    const userIdStr = m?.userId ? String(m.userId) : "";
    const membershipIdStr = m?._id ? String(m._id) : "";
    if (!Types.ObjectId.isValid(orgIdStr) || !Types.ObjectId.isValid(userIdStr)) continue;
    const docMode = (m?.docUpdateEmailMode ?? "daily") as Mode;
    const repoMode = (m?.repoLinkRequestEmailMode ?? "daily") as Mode;
    const viewMode = normalizeViewEmailMode(m?.viewEmailMode);
    const arr = byOrg.get(orgIdStr) ?? [];
    arr.push({ membershipId: membershipIdStr, orgId: orgIdStr, userId: userIdStr, docMode, repoMode, viewMode });
    byOrg.set(orgIdStr, arr);
  }

  const todayUtc = utcDayKey(now);
  const allowDaily = shouldSendDailyUtc(now, forceDigest);

  const totals: SendNotificationEmailsResult = {
    ok: true,
    now: now.toISOString(),
    dryRun,
    workspacesProcessed: 0,
    membersProcessed: 0,
    membersTruncated,
    sendFailures: 0,
    docUpdate: {
      immediate: { members: 0, emails: 0, events: 0, failed: 0 },
      daily: { members: 0, emails: 0, events: 0, failed: 0, sentTodayUtc: allowDaily },
    },
    repoLinkRequests: {
      immediate: { members: 0, emails: 0, events: 0, failed: 0 },
      daily: { members: 0, emails: 0, events: 0, failed: 0, sentTodayUtc: allowDaily },
    },
    views: emptyViewNotificationTotals(allowDaily),
  };

  const defaultLookbackMs = defaultLookbackDays * 24 * 60 * 60 * 1000;
  const defaultStart = new Date(now.getTime() - defaultLookbackMs);

  for (const [orgIdStr, mems] of byOrg.entries()) {
    totals.workspacesProcessed += 1;
    totals.membersProcessed += mems.length;
    const orgId = new Types.ObjectId(orgIdStr);

    // --- Load recipient emails for all members in this org (one query).
    const userIds = Array.from(new Set(mems.map((m) => m.userId)));
    const users = await UserModel.find({ _id: { $in: userIds.map((id) => new Types.ObjectId(id)) }, isActive: { $ne: false } })
      .select({ _id: 1, email: 1, name: 1 })
      .lean();
    const userById = new Map<string, { email: string | null; name: string | null }>();
    for (const u of users as any[]) {
      const id = u?._id ? String(u._id) : "";
      if (!Types.ObjectId.isValid(id)) continue;
      const email = typeof u?.email === "string" ? String(u.email).trim() : "";
      const name = typeof u?.name === "string" ? String(u.name).trim() : "";
      userById.set(id, { email: email || null, name: name || null });
    }

    // ---------- DOC UPDATES (source: DocChange.createdDate) ----------
    const docMembers = mems.filter((m) => m.docMode !== "off");
    if (docMembers.length) {
      const cursorRows = await NotificationEmailCursorModel.find({
        orgId,
        userId: { $in: docMembers.map((m) => new Types.ObjectId(m.userId)) },
        key: "doc_updates",
      })
        .select({ userId: 1, lastNotifiedAt: 1, lastDigestDay: 1 })
        .lean();
      const cursorByUser = new Map<string, { lastNotifiedAt: Date | null; lastDigestDay: string | null }>();
      for (const c of cursorRows as any[]) {
        const uid = c?.userId ? String(c.userId) : "";
        if (!Types.ObjectId.isValid(uid)) continue;
        cursorByUser.set(uid, {
          lastNotifiedAt: c?.lastNotifiedAt ? new Date(c.lastNotifiedAt) : null,
          lastDigestDay: typeof c?.lastDigestDay === "string" ? c.lastDigestDay : null,
        });
      }

      let minCursor = defaultStart;
      for (const m of docMembers) {
        const cur = cursorByUser.get(m.userId);
        const at = cur?.lastNotifiedAt;
        if (at && at < minCursor) minCursor = at;
      }

      const changes = await DocChangeModel.find({
        orgId,
        createdDate: { $gt: minCursor },
      })
        .sort({ createdDate: 1, _id: 1 })
        .limit(limitEventsPerOrg)
        .select({ _id: 1, docId: 1, createdByUserId: 1, toVersion: 1, diff: 1, createdDate: 1 })
        .lean();

      const docIds = Array.from(new Set((changes as any[]).map((c) => (c?.docId ? String(c.docId) : "")).filter(Types.ObjectId.isValid)));
      const docs = await DocModel.find({ _id: { $in: docIds.map((id) => new Types.ObjectId(id)) }, orgId, isDeleted: { $ne: true } })
        .select({ _id: 1, title: 1 })
        .lean();
      const docTitleById = new Map<string, string>();
      for (const d of docs as any[]) {
        const id = d?._id ? String(d._id) : "";
        if (!Types.ObjectId.isValid(id)) continue;
        const title = typeof d?.title === "string" ? d.title.trim() : "";
        docTitleById.set(id, title || "Document");
      }

      // Sender loop per member.
      for (const m of docMembers) {
        const recipient = userById.get(m.userId) ?? (await getRecipientEmail(m.userId));
        if (!recipient.email) continue;

        const cur = cursorByUser.get(m.userId);
        const lastAt = cur?.lastNotifiedAt ?? defaultStart;
        const pending = (changes as any[]).filter((c) => c?.createdDate && new Date(c.createdDate) > lastAt);
        if (!pending.length) continue;

        const sendDaily = m.docMode === "daily";
        const sendImmediate = m.docMode === "immediate";

        if (sendDaily) {
          if (!allowDaily) continue;
          if ((cur?.lastDigestDay ?? null) === todayUtc) continue;

          const batch = pending.slice(0, limitEventsPerMember);
          const subject = `Daily digest: ${batch.length} doc update${batch.length === 1 ? "" : "s"}`;
          const lines: string[] = [];
          lines.push(`Doc updates in your workspace (${orgIdStr})`, "");
          for (const c of batch) {
            const did = c?.docId ? String(c.docId) : "";
            const title = docTitleById.get(did) ?? "Document";
            const v = Number.isFinite(c?.toVersion) ? Number(c.toVersion) : null;
            const summary = typeof c?.diff?.summary === "string" ? String(c.diff.summary).trim() : "";
            lines.push(`- ${title}${v ? ` (v${v})` : ""}`);
            if (summary) lines.push(`  ${summary}`);
            lines.push(`  ${buildDocHistoryUrl(did)}`);
          }
          lines.push("", "- LinkDrop");

          const sent = await trySendEmail({
            dryRun,
            to: recipient.email,
            subject,
            text: lines.join("\n"),
            context: { orgId: orgIdStr, userId: m.userId, key: "doc_updates", mode: "daily" },
          });
          if (!sent) {
            totals.sendFailures += 1;
            totals.docUpdate.daily.failed += 1;
            continue;
          }

          totals.docUpdate.daily.members += 1;
          totals.docUpdate.daily.emails += 1;
          totals.docUpdate.daily.events += batch.length;

          const lastSentAt = new Date(batch[batch.length - 1].createdDate);
          // A dry run computes and counts only; moving the cursor would swallow the real send.
          if (!dryRun) {
            await upsertCursor({
              orgId,
              userId: new Types.ObjectId(m.userId),
              key: "doc_updates",
              lastNotifiedAt: lastSentAt,
              lastDigestDay: todayUtc,
            });
          }
        }

        if (sendImmediate) {
          const batch = pending.slice(0, limitEventsPerMember);
          const subject =
            batch.length === 1
              ? `Doc updated: ${docTitleById.get(String(batch[0].docId)) ?? "Document"}`
              : `${batch.length} docs updated`;

          const lines: string[] = [];
          lines.push(`New doc update${batch.length === 1 ? "" : "s"} in your workspace (${orgIdStr})`, "");
          for (const c of batch) {
            const did = c?.docId ? String(c.docId) : "";
            const title = docTitleById.get(did) ?? "Document";
            const v = Number.isFinite(c?.toVersion) ? Number(c.toVersion) : null;
            const summary = typeof c?.diff?.summary === "string" ? String(c.diff.summary).trim() : "";
            lines.push(`- ${title}${v ? ` (v${v})` : ""}`);
            if (summary) lines.push(`  ${summary}`);
            lines.push(`  ${buildDocUrl(did)}`);
          }
          lines.push("", "- LinkDrop");

          const sent = await trySendEmail({
            dryRun,
            to: recipient.email,
            subject,
            text: lines.join("\n"),
            context: { orgId: orgIdStr, userId: m.userId, key: "doc_updates", mode: "immediate" },
          });
          if (!sent) {
            totals.sendFailures += 1;
            totals.docUpdate.immediate.failed += 1;
            continue;
          }

          totals.docUpdate.immediate.members += 1;
          totals.docUpdate.immediate.emails += 1;
          totals.docUpdate.immediate.events += batch.length;

          const lastSentAt = new Date(batch[batch.length - 1].createdDate);
          // A dry run computes and counts only; moving the cursor would swallow the real send.
          if (!dryRun) {
            await upsertCursor({
              orgId,
              userId: new Types.ObjectId(m.userId),
              key: "doc_updates",
              lastNotifiedAt: lastSentAt,
            });
          }
        }
      }
    }

    // ---------- REPO LINK REQUESTS (source: Upload.updatedDate + Doc.receivedViaRequestProjectId) ----------
    const repoMembers = FEATURE_REQUESTS_ENABLED ? mems.filter((m) => m.repoMode !== "off") : [];
    if (repoMembers.length) {
      const cursorRows = await NotificationEmailCursorModel.find({
        orgId,
        userId: { $in: repoMembers.map((m) => new Types.ObjectId(m.userId)) },
        key: "repo_link_requests",
      })
        .select({ userId: 1, lastNotifiedAt: 1, lastDigestDay: 1 })
        .lean();
      const cursorByUser = new Map<string, { lastNotifiedAt: Date | null; lastDigestDay: string | null }>();
      for (const c of cursorRows as any[]) {
        const uid = c?.userId ? String(c.userId) : "";
        if (!Types.ObjectId.isValid(uid)) continue;
        cursorByUser.set(uid, {
          lastNotifiedAt: c?.lastNotifiedAt ? new Date(c.lastNotifiedAt) : null,
          lastDigestDay: typeof c?.lastDigestDay === "string" ? c.lastDigestDay : null,
        });
      }

      let minCursor = defaultStart;
      for (const m of repoMembers) {
        const cur = cursorByUser.get(m.userId);
        const at = cur?.lastNotifiedAt;
        if (at && at < minCursor) minCursor = at;
      }

      const uploads = await UploadModel.find({
        orgId,
        isDeleted: { $ne: true },
        version: 1,
        status: "completed",
        updatedDate: { $gt: minCursor },
      })
        .sort({ updatedDate: 1, _id: 1 })
        .limit(limitEventsPerOrg)
        .select({ _id: 1, docId: 1, updatedDate: 1 })
        .lean();

      const uploadRows = (uploads as any[])
        .map((u) => ({
          uploadId: u?._id ? String(u._id) : "",
          docId: u?.docId ? String(u.docId) : "",
          updatedDate: u?.updatedDate ? new Date(u.updatedDate) : null,
        }))
        .filter((u) => Types.ObjectId.isValid(u.uploadId) && Types.ObjectId.isValid(u.docId) && u.updatedDate);

      const requestDocs = await DocModel.find({
        _id: { $in: uploadRows.map((u) => new Types.ObjectId(u.docId)) },
        orgId,
        isDeleted: { $ne: true },
        receivedViaRequestProjectId: { $ne: null },
      })
        .select({ _id: 1, title: 1, receivedViaRequestProjectId: 1 })
        .lean();

      const requestDocById = new Map<string, { title: string; requestProjectId: string }>();
      const requestProjectIds = new Set<string>();
      for (const d of requestDocs as any[]) {
        const did = d?._id ? String(d._id) : "";
        const pidRaw = d?.receivedViaRequestProjectId ? String(d.receivedViaRequestProjectId) : "";
        if (!Types.ObjectId.isValid(did) || !Types.ObjectId.isValid(pidRaw)) continue;
        const title = typeof d?.title === "string" ? d.title.trim() : "";
        requestDocById.set(did, { title: title || "Document", requestProjectId: pidRaw });
        requestProjectIds.add(pidRaw);
      }

      const projects = requestProjectIds.size
        ? await ProjectModel.find({ _id: { $in: Array.from(requestProjectIds).map((id) => new Types.ObjectId(id)) }, orgId, isDeleted: { $ne: true } })
            .select({ _id: 1, name: 1 })
            .lean()
        : [];
      const projectNameById = new Map<string, string>();
      for (const p of projects as any[]) {
        const pid = p?._id ? String(p._id) : "";
        if (!Types.ObjectId.isValid(pid)) continue;
        const name = typeof p?.name === "string" ? p.name.trim() : "";
        projectNameById.set(pid, name || "Request");
      }

      // Only keep uploads whose docs are request-docs.
      const requestEvents = uploadRows
        .map((u) => {
          const d = requestDocById.get(u.docId);
          if (!d) return null;
          return {
            uploadId: u.uploadId,
            docId: u.docId,
            occurredAt: u.updatedDate as Date,
            requestProjectId: d.requestProjectId,
            docTitle: d.title,
            requestName: projectNameById.get(d.requestProjectId) ?? "Request",
          };
        })
        .filter(Boolean) as Array<{
        uploadId: string;
        docId: string;
        occurredAt: Date;
        requestProjectId: string;
        docTitle: string;
        requestName: string;
      }>;

      for (const m of repoMembers) {
        const recipient = userById.get(m.userId) ?? (await getRecipientEmail(m.userId));
        if (!recipient.email) continue;

        const cur = cursorByUser.get(m.userId);
        const lastAt = cur?.lastNotifiedAt ?? defaultStart;
        const pending = requestEvents.filter((e) => e.occurredAt > lastAt);
        if (!pending.length) continue;

        const sendDaily = m.repoMode === "daily";
        const sendImmediate = m.repoMode === "immediate";

        if (sendDaily) {
          if (!allowDaily) continue;
          if ((cur?.lastDigestDay ?? null) === todayUtc) continue;

          const batch = pending.slice(0, limitEventsPerMember);
          const subject = `Daily digest: ${batch.length} repo link request${batch.length === 1 ? "" : "s"}`;
          const lines: string[] = [];
          lines.push(`New request uploads in your workspace (${orgIdStr})`, "");
          for (const e of batch) {
            lines.push(`- ${e.requestName}: ${e.docTitle}`);
            lines.push(`  ${buildDocUrl(e.docId)}`);
          }
          lines.push("", `Requests: ${buildRequestsUrl()}`, "", "- LinkDrop");

          const sent = await trySendEmail({
            dryRun,
            to: recipient.email,
            subject,
            text: lines.join("\n"),
            context: { orgId: orgIdStr, userId: m.userId, key: "repo_link_requests", mode: "daily" },
          });
          if (!sent) {
            totals.sendFailures += 1;
            totals.repoLinkRequests.daily.failed += 1;
            continue;
          }

          totals.repoLinkRequests.daily.members += 1;
          totals.repoLinkRequests.daily.emails += 1;
          totals.repoLinkRequests.daily.events += batch.length;

          const lastSentAt = batch[batch.length - 1].occurredAt;
          // A dry run computes and counts only; moving the cursor would swallow the real send.
          if (!dryRun) {
            await upsertCursor({
              orgId,
              userId: new Types.ObjectId(m.userId),
              key: "repo_link_requests",
              lastNotifiedAt: lastSentAt,
              lastDigestDay: todayUtc,
            });
          }
        }

        if (sendImmediate) {
          const batch = pending.slice(0, limitEventsPerMember);
          const subject =
            batch.length === 1
              ? `Repo link request: ${batch[0].requestName}`
              : `${batch.length} repo link requests`;
          const lines: string[] = [];
          lines.push(`New request upload${batch.length === 1 ? "" : "s"} in your workspace (${orgIdStr})`, "");
          for (const e of batch) {
            lines.push(`- ${e.requestName}: ${e.docTitle}`);
            lines.push(`  ${buildDocUrl(e.docId)}`);
          }
          lines.push("", `Requests: ${buildRequestsUrl()}`, "", "- LinkDrop");

          const sent = await trySendEmail({
            dryRun,
            to: recipient.email,
            subject,
            text: lines.join("\n"),
            context: { orgId: orgIdStr, userId: m.userId, key: "repo_link_requests", mode: "immediate" },
          });
          if (!sent) {
            totals.sendFailures += 1;
            totals.repoLinkRequests.immediate.failed += 1;
            continue;
          }

          totals.repoLinkRequests.immediate.members += 1;
          totals.repoLinkRequests.immediate.emails += 1;
          totals.repoLinkRequests.immediate.events += batch.length;

          const lastSentAt = batch[batch.length - 1].occurredAt;
          // A dry run computes and counts only; moving the cursor would swallow the real send.
          if (!dryRun) {
            await upsertCursor({
              orgId,
              userId: new Types.ObjectId(m.userId),
              key: "repo_link_requests",
              lastNotifiedAt: lastSentAt,
            });
          }
        }
      }
    }

    // ---------- VIEWS (source: ShareView.createdDate, ShareVisit.createdDate for returns) ----------
    const viewMembers = mems.filter((m) => Types.ObjectId.isValid(m.membershipId));
    if (viewMembers.length) {
      try {
        const { sendFailures } = await runViewNotificationsForOrg(
          {
            orgId: orgIdStr,
            members: viewMembers.map((m) => ({ membershipId: m.membershipId, userId: m.userId, mode: m.viewMode })),
            recipients: userById,
            now,
            dryRun,
            allowDaily,
            todayUtc,
            limitEventsPerMember,
            defaultLookbackDays,
            appUrl: publicBaseUrl(),
          },
          {
            send: ({ to, subject, text, html, headers, context }) =>
              trySendEmail({ dryRun, to, subject, text, html, headers, context: { ...context, key: "share_views" } }),
            upsertCursor: ({ orgId: cursorOrgId, userId: cursorUserId, lastNotifiedAt, returnsNotifiedAt, lastDigestDay }) =>
              upsertCursor({ orgId: cursorOrgId, userId: cursorUserId, key: "share_views", lastNotifiedAt, returnsNotifiedAt, lastDigestDay }),
          },
          totals.views,
        );
        totals.sendFailures += sendFailures;
      } catch (err) {
        // A failure here must not stop doc-update/request emails for the remaining workspaces.
        totals.views.errors += 1;
        debugError(1, "[notification-emails] view notifications failed", {
          orgId: orgIdStr,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return totals;
}

