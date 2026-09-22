/**
 * The body of a document-update email.
 *
 * Pulled out of `sendNotificationEmails.ts`, where it was assembled inline as a list of strings.
 * That had three consequences, and none of them were visible from the previews page — because the
 * previews page calls builders, and this was not one.
 *
 *   - **Plain text only.** Every other email gained an HTML part; these did not, because they never
 *     went through the block renderer.
 *   - **No way out.** View emails carry a one-click unsubscribe in the footer and an RFC 8058
 *     header. These carried neither, so the only way to stop them was to find the setting in the
 *     dashboard. Somebody who cannot unsubscribe in one click presses Spam instead, and that
 *     costs the sending domain far more than the email was worth.
 *   - **It printed the workspace's ObjectId.** The opening line read "Doc updates in your workspace
 *     (68c1f0a2b3c4d5e6f7a80001)", because the id was the only thing about the workspace in scope.
 *
 * Being a pure function fixes the first of those by construction and makes the other two testable:
 * the previews page and `scripts/send-test-emails.ts` can both render it now.
 */
import type { Block, EmailWorkspace } from "@/lib/email/layout";
import { renderHtml, renderText } from "@/lib/email/layout";

/** One replaced document, already resolved to what the reader should see. */
export type DocUpdateEntry = {
  title: string;
  /** The new version, when we know it. */
  version: number | null;
  /** One sentence on what changed; empty when the comparison produced nothing. */
  summary: string;
  /**
   * The itemised changes, when the comparison produced them.
   *
   * `DocChange.diff.changes` has been populated all along and no email ever showed it — the mail
   * said "Pricing page rewritten" and stopped, when the record underneath listed each change with
   * a title. A person deciding whether to reopen a deck wants the list, not the sentence.
   */
  changes: string[];
  /** 1-based page numbers the comparison flagged, from `diff.pagesThatChanged`. */
  pagesChanged: number[];
  /** Where the comparison itself lives — the document's history. */
  historyUrl: string;
  /** The document as it now stands. */
  docUrl: string;
};

export type ComposedDocUpdateEmail = {
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
};

export function docUpdateSubject(entries: readonly DocUpdateEntry[], daily: boolean): string {
  if (daily) return `${entries.length} document${entries.length === 1 ? "" : "s"} updated today`;
  if (entries.length === 1) return `Updated: ${entries[0]!.title}`;
  return `${entries.length} documents were updated`;
}

export function composeDocUpdateEmail(params: {
  entries: readonly DocUpdateEntry[];
  daily: boolean;
  workspace: EmailWorkspace | null;
  /** Signed one-click off link, scoped to doc-update mail rather than to view mail. */
  offUrl: string;
  /** Where "Change how often" goes. */
  preferencesUrl: string;
  turnOffLabel: string;
  changeHowOftenLabel: string;
}): ComposedDocUpdateEmail {
  const { entries, daily, workspace, offUrl } = params;
  const subject = docUpdateSubject(entries, daily);
  const one = entries.length === 1;

  const blocks: Block[] = [
    {
      kind: "heading",
      text: daily
        ? `${entries.length} document${one ? "" : "s"} updated today`
        : one
          ? `${entries[0]!.title} was replaced`
          : `${entries.length} documents were replaced`,
    },
  ];

  if (one) {
    // One document: the title is the heading, so the body is the change itself.
    const only = entries[0]!;
    const facts: Array<[string, string]> = [];
    if (only.version) facts.push(["Version", `v${only.version}`]);
    // Which pages moved is the fastest way to judge whether a change matters, and it was thrown
    // away entirely: the record has page numbers, the email had none.
    if (only.pagesChanged.length) {
      facts.push([
        only.pagesChanged.length === 1 ? "Page changed" : "Pages changed",
        only.pagesChanged.join(", "),
      ]);
    }
    if (facts.length) blocks.push({ kind: "rows", rows: facts });
    if (only.summary) blocks.push({ kind: "p", text: only.summary });
    if (only.changes.length) blocks.push({ kind: "bullets", items: only.changes });
    // The comparison is what the email is about, so it gets the button; the document itself is
    // one line below for anyone who wants the thing rather than the difference.
    blocks.push({ kind: "action", label: "See what changed", url: only.historyUrl });
    blocks.push({ kind: "links", items: [{ label: "Open the document", url: only.docUrl }] });
  } else {
    /**
     * Several: each title is itself the link, with its summary under it.
     *
     * The first version listed the titles as headings and then repeated every one of them as a
     * link underneath, which read as two lists of the same documents. A dozen identical black
     * buttons was the other option and is worse.
     */
    for (const entry of entries) {
      blocks.push({
        kind: "links",
        items: [{ label: entry.version ? `${entry.title} (v${entry.version})` : entry.title, url: entry.historyUrl }],
      });
      if (entry.summary) blocks.push({ kind: "muted", text: entry.summary });
    }
  }

  const footer = {
    reason: workspace?.name
      ? `You get this because a document was replaced in ${workspace.name}.`
      : "You get this because a document was replaced in your workspace.",
    links: [
      { label: params.turnOffLabel, url: offUrl },
      { label: params.changeHowOftenLabel, url: params.preferencesUrl },
    ],
  };

  const preheader = one && entries[0]!.summary ? entries[0]!.summary : `${entries.length} replaced`;

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
