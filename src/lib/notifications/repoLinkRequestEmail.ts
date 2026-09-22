/**
 * "Something landed in a request inbox" — the body of the repo-link-request email.
 *
 * The last of the four notification emails still assembled as a list of strings inside the cron,
 * and it carried the same three faults its siblings did: no HTML, no way to unsubscribe, and an
 * opening line that printed the workspace's ObjectId at the reader —
 *
 *   New request uploads in your workspace (68c1f0a2b3c4d5e6f7a80001)
 *
 * It is behind a feature flag, so nobody has met any of that yet. Converting it now means the flag
 * can be turned on without a round of "why does this one look different".
 */
import type { Block, EmailWorkspace } from "@/lib/email/layout";
import { renderHtml, renderText } from "@/lib/email/layout";

/** One file that arrived in a request inbox. */
export type RepoLinkRequestEntry = {
  /** The request repo it landed in — the thing the owner recognises. */
  requestName: string;
  docTitle: string;
  docUrl: string;
};

export type ComposedRepoLinkRequestEmail = {
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
};

export function repoLinkRequestSubject(entries: readonly RepoLinkRequestEntry[], daily: boolean): string {
  if (daily) return `${entries.length} file${entries.length === 1 ? "" : "s"} arrived today`;
  if (entries.length === 1) return `New in ${entries[0]!.requestName}: ${entries[0]!.docTitle}`;
  return `${entries.length} files arrived`;
}

export function composeRepoLinkRequestEmail(params: {
  entries: readonly RepoLinkRequestEntry[];
  daily: boolean;
  workspace: EmailWorkspace | null;
  /** Where the owner reviews what arrived. */
  requestsUrl: string;
  /** Signed one-click off link, scoped to this kind. */
  offUrl: string;
  preferencesUrl: string;
  turnOffLabel: string;
  changeHowOftenLabel: string;
}): ComposedRepoLinkRequestEmail {
  const { entries, daily, workspace, offUrl } = params;
  const subject = repoLinkRequestSubject(entries, daily);
  const one = entries.length === 1;

  const blocks: Block[] = [
    {
      kind: "heading",
      text: daily
        ? `${entries.length} file${one ? "" : "s"} arrived today`
        : one
          ? `A file arrived in ${entries[0]!.requestName}`
          : `${entries.length} files arrived`,
    },
  ];

  if (one) {
    const only = entries[0]!;
    blocks.push({
      kind: "rows",
      rows: [
        ["Request", only.requestName],
        ["File", only.docTitle],
      ],
    });
    blocks.push({ kind: "action", label: "Open it", url: only.docUrl });
  } else {
    // Grouped by request, because "which inbox" is the first thing the owner sorts by.
    for (const entry of entries) {
      blocks.push({ kind: "links", items: [{ label: entry.docTitle, url: entry.docUrl }] });
      blocks.push({ kind: "muted", text: entry.requestName });
    }
    blocks.push({ kind: "action", label: "Review requests", url: params.requestsUrl });
  }

  const footer = {
    reason: workspace?.name
      ? `You get this because a file arrived in a request inbox in ${workspace.name}.`
      : "You get this because a file arrived in one of your request inboxes.",
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
      preheader: one ? entries[0]!.requestName : `${entries.length} across your request inboxes`,
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
