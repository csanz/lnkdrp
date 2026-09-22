/**
 * "Someone added a document" — the body of the new-document email.
 *
 * The sibling of `docUpdateEmail.ts`, and deliberately not the same mail. A replacement asks "what
 * changed"; this one asks "what is this". There is no diff to show, no version worth printing, and
 * the useful facts are different: who added it, and how long it is.
 *
 * It never reaches the person who uploaded — that is decided at enqueue, in the upload processor,
 * because an email confirming your own action is the fastest way to teach somebody to filter this
 * whole class of mail.
 */
import type { Block, EmailWorkspace } from "@/lib/email/layout";
import { renderHtml, renderText } from "@/lib/email/layout";

/** One newly added document, already resolved to what the reader should see. */
export type DocUploadEntry = {
  title: string;
  /** Who added it, when we can name them. Falls back to "Someone" rather than an empty phrase. */
  uploadedBy: string | null;
  /** Page count, when known — the one fact that says whether this is a memo or a data room. */
  pages: number | null;
  url: string;
};

export type ComposedDocUploadEmail = {
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
};

/** "Dana Lee" / "Someone", never an empty string dropped into the middle of a sentence. */
function who(entry: DocUploadEntry): string {
  return (entry.uploadedBy ?? "").trim() || "Someone";
}

export function docUploadSubject(entries: readonly DocUploadEntry[], daily: boolean): string {
  if (daily) return `${entries.length} new document${entries.length === 1 ? "" : "s"}`;
  if (entries.length === 1) return `${who(entries[0]!)} added "${entries[0]!.title}"`;
  return `${entries.length} documents were added`;
}

export function composeDocUploadEmail(params: {
  entries: readonly DocUploadEntry[];
  daily: boolean;
  workspace: EmailWorkspace | null;
  /** Signed one-click off link, scoped to this kind rather than to view or doc-update mail. */
  offUrl: string;
  preferencesUrl: string;
  turnOffLabel: string;
  changeHowOftenLabel: string;
}): ComposedDocUploadEmail {
  const { entries, daily, workspace, offUrl } = params;
  const subject = docUploadSubject(entries, daily);
  const one = entries.length === 1;

  const blocks: Block[] = [
    {
      kind: "heading",
      text: daily
        ? `${entries.length} new document${one ? "" : "s"}`
        : one
          ? `${who(entries[0]!)} added a document`
          : `${entries.length} documents were added`,
    },
  ];

  if (one) {
    const only = entries[0]!;
    const facts: Array<[string, string]> = [["Document", only.title]];
    if (only.pages && only.pages > 0) facts.push(["Pages", String(only.pages)]);
    blocks.push({ kind: "rows", rows: facts });
    blocks.push({ kind: "action", label: "Open the document", url: only.url });
  } else {
    // Each title is its own link, with who added it underneath — the same shape the doc-update
    // digest settled on, after listing titles and then repeating them as links read as two lists.
    for (const entry of entries) {
      blocks.push({ kind: "links", items: [{ label: entry.title, url: entry.url }] });
      blocks.push({
        kind: "muted",
        text: entry.pages && entry.pages > 0 ? `${who(entry)} · ${entry.pages} pages` : `${who(entry)}`,
      });
    }
  }

  const footer = {
    reason: workspace?.name
      ? `You get this because someone added a document to ${workspace.name}.`
      : "You get this because someone added a document to your workspace.",
    links: [
      { label: params.turnOffLabel, url: offUrl },
      { label: params.changeHowOftenLabel, url: params.preferencesUrl },
    ],
  };

  return {
    subject,
    text: renderText(blocks, footer, workspace),
    html: renderHtml({
      subject,
      preheader: one ? `${who(entries[0]!)} added it` : `${entries.length} added`,
      blocks,
      footer,
      workspace,
    }),
    headers: {
      "List-Unsubscribe": `<${offUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}
