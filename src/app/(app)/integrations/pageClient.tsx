"use client";

/**
 * The integrations list: one card per tool, a status pill, and a button into its page.
 *
 * Slack is the only entry today. The array below is the whole registry: a new integration is a
 * new entry plus its own detail page. Status comes from `useSlackConnections`, the same hook the
 * Slack page uses, so the two never disagree.
 */
import Link from "next/link";
import { PuzzlePieceIcon } from "@heroicons/react/24/outline";

import AppPageHeader, { APP_PAGE_GUTTER } from "@/components/AppPageHeader";
import { SlackMark, useSlackConnections, slackStatusLine, type SlackState } from "./slack/slackShared";

export default function IntegrationsPageClient({ initialSlack }: { initialSlack: SlackState | null }) {
  const slack = useSlackConnections(initialSlack);
  const status = slackStatusLine(slack);

  const integrations = [
    {
      id: "slack",
      name: "Slack",
      description: "Opens, visit briefs, replaced documents and received files, posted to a channel you choose. Route each project to its own channel.",
      href: "/integrations/slack",
      mark: <SlackMark className="h-8 w-8" />,
      status,
      // Never claim a state the page has not been told. Until the answer lands (a full reload
      // has no cached one) the button says "Open", which is true whatever the answer turns out
      // to be; it becomes Manage or Set up when the data does, and never flips the other way.
      cta: !slack.data ? "Open" : slack.data.connections.length ? "Manage" : "Set up",
    },
  ];

  return (
    <div className="flex h-full flex-col">
      <AppPageHeader icon={PuzzlePieceIcon} title="Integrations" description="Where this workspace's activity goes besides email. Owners and admins can connect and change these." />
      <div className={`min-h-0 flex-1 overflow-auto bg-[var(--bg)] ${APP_PAGE_GUTTER} py-6`}>
        <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {integrations.map((it) => (
            <li key={it.id} className="flex flex-col rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5 shadow-[var(--shadow-card)]">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  {it.mark}
                  <div className="text-[15px] font-semibold text-[var(--fg)]">{it.name}</div>
                </div>
                <span
                  className={[
                    "shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold",
                    it.status.tone === "on"
                      ? "border-transparent bg-[var(--chart-views)]/15 text-[var(--fg)]"
                      : it.status.tone === "warn"
                        ? "border-transparent bg-[var(--plan-ending-bg)] text-[var(--plan-ending-fg)]"
                        : "border-[var(--border)] bg-[var(--panel-2)] text-[var(--muted-2)]",
                  ].join(" ")}
                >
                  {it.status.text}
                </span>
              </div>
              <p className="mt-3 flex-1 text-[13px] leading-5 text-[var(--muted)]">{it.description}</p>
              <Link
                href={it.href}
                className="mt-5 inline-flex w-full items-center justify-center rounded-lg bg-[var(--fg)] px-3 py-2 text-[13px] font-semibold text-[var(--bg)] hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
              >
                {it.cta}
              </Link>
            </li>
          ))}
        </ul>
        <p className="mt-6 text-[12px] text-[var(--muted-2)]">More integrations are coming. Tell us which one you need from the support bubble.</p>
      </div>
    </div>
  );
}
