/**
 * "Sequoia read the deck for 6 minutes, mostly pricing" — the visit brief email.
 *
 * The sibling of the open email in `viewNotifications.ts`, and deliberately a different mail. The
 * open email fires at the first page and can only say *that* someone opened a link. This one fires
 * minutes after they leave and says what happened: the model's account when a brief was written,
 * and the facts of the visit either way (a recap, when credits or the switch said no).
 *
 * Identity is not gated here: a brief only ever exists on a Pro workspace (decision 8), and the
 * feed row and reader page show the same names. The subject is the brief's headline, which the
 * model is told to keep to twelve words so it survives a notification banner.
 */
import type { Block, EmailFooter, EmailWorkspace } from "@/lib/email/layout";
import { renderHtml, renderText } from "@/lib/email/layout";
import { formatDuration, formatWhenUtc, sanitizeInline } from "@/lib/notifications/viewNotifications";

/** One page, how long it held the reader, and how many separate times they opened it. */
export type VisitBriefPageLine = { page: number; heading: string | null; ms: number; opened: number };

/** One visit, resolved to what the reader of the email should see. */
export type VisitBriefEntry = {
  /** Who: a name or an address when known, else null (the copy says "a reader"). */
  viewerLabel: string | null;
  /** "Sequoia" or null for the default link. */
  linkLabel: string | null;
  audience: string | null;
  /** The document, or the data room's name. */
  title: string;
  /** Documents opened inside a data-room sitting; empty for a document link. */
  docsOpened: string[];
  startedAt: Date;
  endedAt: Date;
  timeSpentMs: number;
  pagesSeen: number;
  pageCount: number | null;
  downloads: number;
  visitNumber: number;
  /** The previous visit's length and start, when there was one. */
  lastVisitMs: number | null;
  lastVisitAt: Date | null;
  /** Longest pages first. */
  topPages: VisitBriefPageLine[];
  /** The reading order — every page turn, returns included. Capped by the sender. */
  path: number[];
  /** Pages never opened, as printed ranges ("9–12"). */
  skipped: string[];
  brief: { headline: string; body: string; interests: string[]; highlights: string[]; followUp: string | null } | null;
  /** Why there is no brief, in the reader's language, or null when there is one. */
  recapLine: string | null;
  /** The stored reason, so a credits recap can offer the way to fix it. */
  recapReason?: string | null;
  /** Deep link to the reader's page, or the metrics page when that cannot be addressed. */
  url: string;
  /** The document (or data room) itself, in the app. */
  docUrl: string | null;
};

export type ComposedVisitBriefEmail = {
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
};

export const VISIT_BRIEF_FOOTER_REASON = "You get this because a recipient finished reading a document in your workspace.";
export const VISIT_BRIEF_ACTION_LABEL = "See the whole visit";
export const VISIT_BRIEF_DOC_LABEL = "Open the document";

/** The recap lines, keyed by `VisitBrief.recapReason`. */
export const RECAP_LINES: Record<string, string> = {
  out_of_credits:
    "No brief this time: this workspace is out of credits, so the AI write-up is paused until credits are added. The facts of the visit are below.",
  daily_cap: "The AI write-up was skipped: this workspace hit today's limit on briefs. The facts of the visit are below.",
  auto_off: "Automatic briefs are off for this workspace, so this is the visit without the write-up.",
  model_failed: "The AI write-up could not be written this time. The facts of the visit are below.",
};

function who(entry: VisitBriefEntry): string {
  return entry.viewerLabel ?? (entry.linkLabel ? `Someone on the ${entry.linkLabel} link` : "A reader");
}

/**
 * The subject line: who, then what they did.
 *
 * The model writes the headline as a predicate ("spent 5 minutes on pricing") and the name goes in
 * front of it here, so the subject always carries the reader and never depends on the model
 * remembering to. A headline that still begins with a reader designation — the name, "A reader",
 * "Reader", "Someone on the X link" — has it stripped first, so the name is never printed twice.
 */
export function headlineSubject(entry: Pick<VisitBriefEntry, "viewerLabel" | "linkLabel">, headline: string): string {
  const name = entry.viewerLabel ?? null;
  let predicate = sanitizeInline(headline, 160);
  const designations = [
    ...(name ? [name] : []),
    "the reader",
    "a reader",
    "reader",
    "someone on the [^:—-]*? link",
    "someone",
    "the viewer",
    "a viewer",
    "viewer",
  ];
  for (const d of designations) {
    const escaped = d === "someone on the [^:—-]*? link" ? d : d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^(${escaped})\\s*[:—-]?\\s+`, "i");
    if (re.test(predicate)) {
      predicate = predicate.replace(re, "");
      break;
    }
  }
  if (!predicate) return `${who(entry as VisitBriefEntry)} finished reading`;
  const lowered = /^[A-Z][a-z]/.test(predicate) && !/^[A-Z]{2,}/.test(predicate) ? predicate[0]!.toLowerCase() + predicate.slice(1) : predicate;
  return `${who(entry as VisitBriefEntry)} ${lowered}`;
}

/** Print page numbers as ranges: [1,2,3,7,9,10] → ["1–3", "7", "9–10"]. Pure, for tests. */
export function pageRanges(pages: readonly number[]): string[] {
  const sorted = Array.from(new Set(pages.filter((p) => Number.isFinite(p) && p >= 1))).sort((a, b) => a - b);
  const out: string[] = [];
  let start: number | null = null;
  let prev: number | null = null;
  for (const p of sorted) {
    if (start === null) {
      start = p;
      prev = p;
      continue;
    }
    if (p === (prev as number) + 1) {
      prev = p;
      continue;
    }
    out.push(start === prev ? String(start) : `${start}–${prev}`);
    start = p;
    prev = p;
  }
  if (start !== null) out.push(start === prev ? String(start) : `${start}–${prev}`);
  return out;
}

/** "6 min · 4 of 12 pages" */
function howMuch(entry: VisitBriefEntry): string {
  const parts: string[] = [];
  const dur = formatDuration(entry.timeSpentMs);
  if (dur) parts.push(dur);
  if (entry.pagesSeen > 0) {
    parts.push(entry.pageCount ? `${Math.min(entry.pagesSeen, entry.pageCount)} of ${entry.pageCount} pages` : `${entry.pagesSeen} pages`);
  }
  if (entry.downloads > 0) parts.push(entry.downloads === 1 ? "downloaded" : `downloaded ${entry.downloads}×`);
  return parts.join(" · ");
}

export function visitBriefSubject(entries: readonly VisitBriefEntry[], daily: boolean): string {
  if (daily) return `${entries.length} visit${entries.length === 1 ? "" : "s"} to your documents today`;
  const only = entries[0]!;
  if (entries.length === 1) {
    if (only.brief?.headline) return headlineSubject(only, only.brief.headline);
    const dur = formatDuration(only.timeSpentMs);
    return `${who(only)} read "${only.title}"${dur ? ` · ${dur}` : ""}`;
  }
  return `${entries.length} people finished reading your documents`;
}

function pageLine(p: VisitBriefPageLine): string {
  const dur = formatDuration(p.ms) ?? "under a second";
  const times = p.opened > 1 ? ` ×${p.opened}` : "";
  return p.heading ? `p. ${p.page}, ${p.heading}: ${dur}${times}` : `p. ${p.page}: ${dur}${times}`;
}

/** "Sep 20" for a date in this year, "Sep 20, 2025" otherwise. */
function shortDate(d: Date, now = new Date()): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(d.getUTCFullYear() !== now.getUTCFullYear() ? { year: "numeric" } : {}), timeZone: "UTC" });
}

/** The visit row: how many times this reader has been, and what the last one looked like. */
export function visitLine(entry: Pick<VisitBriefEntry, "visitNumber" | "lastVisitMs" | "lastVisitAt">): string {
  if (entry.visitNumber <= 1) return "First visit";
  const last: string[] = [];
  const dur = entry.lastVisitMs !== null ? formatDuration(entry.lastVisitMs) : null;
  if (dur) last.push(dur);
  if (entry.lastVisitAt) last.push(`on ${shortDate(entry.lastVisitAt)}`);
  const back = entry.visitNumber - 1;
  return `${ordinal(entry.visitNumber)} · came back ${back === 1 ? "once" : `${back} times`}${last.length ? ` · last one ${last.join(" ")}` : ""}`;
}

/** The blocks for one visit; shared by the immediate email and each digest section. */
function entryBlocks(entry: VisitBriefEntry, opts: { heading: boolean }): Block[] {
  const blocks: Block[] = [];
  if (opts.heading) blocks.push({ kind: "subheading", text: `${who(entry)} · ${entry.title}` });

  const facts: Array<[string, string]> = [];
  if (entry.viewerLabel) facts.push(["Who", entry.viewerLabel]);
  facts.push([entry.docsOpened.length > 1 ? "Data room" : "Document", entry.title]);
  facts.push(["Link", entry.linkLabel ?? "Default link"]);
  if (entry.audience) facts.push(["Audience", entry.audience]);
  facts.push(["When", formatWhenUtc(entry.startedAt)]);
  facts.push(["How much", howMuch(entry) || "–"]);
  // Always, not only on a return: "First visit" is itself the answer to "have they been before?"
  facts.push(["Visit", visitLine(entry)]);
  if (entry.docsOpened.length > 1) facts.push(["Opened", entry.docsOpened.join(", ")]);
  blocks.push({ kind: "rows", rows: facts });

  if (entry.brief) {
    blocks.push({ kind: "p", text: entry.brief.body });
    if (entry.brief.interests.length) {
      blocks.push({ kind: "subheading", text: "What caught their attention", compact: true });
      blocks.push({ kind: "bullets", items: entry.brief.interests });
    }
    if (entry.brief.highlights.length) blocks.push({ kind: "bullets", items: entry.brief.highlights });
    if (entry.brief.followUp) blocks.push({ kind: "muted", text: `Next: ${entry.brief.followUp}` });
  } else if (entry.recapLine) {
    blocks.push({ kind: "muted", text: entry.recapLine });
  }

  if (entry.topPages.length) {
    // Under a brief the pages are one quiet line: the paragraph and its highlights already tell the
    // story, and a second bulleted list right below reads as the same list twice. A recap has no
    // paragraph, so there the pages are the story and get the room.
    if (entry.brief) blocks.push({ kind: "muted", text: `Time per page: ${entry.topPages.map(pageLine).join(" · ")}` });
    else blocks.push({ kind: "bullets", items: entry.topPages.map(pageLine) });
  }
  if (entry.path.length > 1) {
    blocks.push({ kind: "muted", text: `Path: ${entry.path.join(" → ")}` });
  }
  if (entry.skipped.length) {
    blocks.push({ kind: "muted", text: `Skipped: ${entry.skipped.join(", ")}` });
  }
  return blocks;
}

export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]} visit`;
}

export function composeVisitBriefEmail(params: {
  entries: readonly VisitBriefEntry[];
  daily: boolean;
  workspace: EmailWorkspace | null;
  /** Signed one-click off link, scoped to brief mail. */
  offUrl: string;
  preferencesUrl: string;
  turnOffLabel: string;
  changeHowOftenLabel: string;
  metricsUrl: string | null;
  /** Where to add credits; shown on a recap whose reason is credits. */
  creditsUrl?: string | null;
}): ComposedVisitBriefEmail {
  const { entries, daily, workspace, offUrl } = params;
  const subject = visitBriefSubject(entries, daily);
  const one = entries.length === 1;

  const blocks: Block[] = [];
  if (one && !daily) {
    const only = entries[0]!;
    blocks.push({ kind: "heading", text: only.brief?.headline ? headlineSubject(only, only.brief.headline) : `${who(only)} finished reading "${only.title}"` });
    blocks.push(...entryBlocks(only, { heading: false }));
    // Out of credits is the one recap the reader can fix, so the fix is the first button.
    if (only.recapReason === "out_of_credits" && params.creditsUrl) {
      blocks.push({ kind: "action", label: "Add credits", url: params.creditsUrl });
      blocks.push({ kind: "action", label: VISIT_BRIEF_ACTION_LABEL, url: only.url, variant: "secondary" });
    } else {
      blocks.push({ kind: "action", label: VISIT_BRIEF_ACTION_LABEL, url: only.url });
    }
    if (only.docUrl) blocks.push({ kind: "action", label: only.docsOpened.length > 1 ? "Open the data room" : VISIT_BRIEF_DOC_LABEL, url: only.docUrl, variant: "secondary" });
  } else {
    blocks.push({
      kind: "heading",
      text: daily ? `${entries.length} visit${one ? "" : "s"} today` : `${entries.length} people finished reading`,
    });
    entries.forEach((entry, i) => {
      if (i > 0) blocks.push({ kind: "divider" });
      blocks.push(...entryBlocks(entry, { heading: true }));
      blocks.push({
        kind: "links",
        items: [
          { label: VISIT_BRIEF_ACTION_LABEL, url: entry.url },
          ...(entry.docUrl ? [{ label: entry.docsOpened.length > 1 ? "Open the data room" : VISIT_BRIEF_DOC_LABEL, url: entry.docUrl }] : []),
        ],
      });
    });
    if (entries.some((e) => e.recapReason === "out_of_credits") && params.creditsUrl) {
      blocks.push({ kind: "action", label: "Add credits", url: params.creditsUrl });
    }
    if (params.metricsUrl) blocks.push({ kind: "action", label: "Open analytics", url: params.metricsUrl, variant: "secondary" });
  }

  const footer: EmailFooter = {
    reason: workspace?.name ? `You get this because a recipient finished reading a document in ${workspace.name}.` : VISIT_BRIEF_FOOTER_REASON,
    links: [
      { label: params.turnOffLabel, url: offUrl },
      { label: params.changeHowOftenLabel, url: params.preferencesUrl },
    ],
  };

  const first = entries[0]!;
  const preheader = one
    ? first.brief
      ? sanitizeInline(first.brief.body, 140)
      : `${who(first)} · ${howMuch(first)}`
    : entries
        .slice(0, 3)
        .map((e) => `${who(e)} · ${formatDuration(e.timeSpentMs) ?? "a moment"}`)
        .join(" · ");

  return {
    subject,
    text: renderText(blocks, footer, workspace),
    html: renderHtml({ subject, preheader, blocks, footer, workspace }),
    headers: {
      "List-Unsubscribe": `<${offUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}
