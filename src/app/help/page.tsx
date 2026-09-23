/**
 * `/help` — the index of customer-facing help articles.
 *
 * One card per article in `src/content/help`, in `order`. The same public frame as the MCP
 * guides. This page and every article are in the sitemap so Plain's AI agent can index them and
 * answer support chat from them; see `src/lib/help/articles.ts`.
 */
import type { Metadata } from "next";
import Link from "next/link";

import PublicGuideShell from "@/components/connect/PublicGuideShell";
import SupportLink from "@/components/support/SupportLink";
import { listHelpArticles } from "@/lib/help/articles";

export const metadata: Metadata = {
  title: "Help",
  description: "How lnkdrp works: share links, analytics, notifications, credits, projects, teams and connecting your AI agent.",
  alternates: { canonical: "/help" },
};

/** Render the help index. */
export default function HelpIndexPage() {
  const articles = listHelpArticles();
  return (
    <PublicGuideShell>
      <p className="mb-4 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/55">Help</p>
      <h1 className="font-serif text-4xl leading-[1.05] tracking-tight text-white sm:text-5xl">How lnkdrp works</h1>
      <p className="mt-5 max-w-xl text-sm leading-6 text-white/60 sm:text-base">
        Short answers to the questions people ask. If yours is not here,{" "}
        <SupportLink className="font-medium text-white underline-offset-4 hover:underline">talk to us</SupportLink> and we reply
        within a business day.
      </p>

      <ol className="mt-10 grid gap-4 sm:grid-cols-2">
        {articles.map((a) => (
          <li key={a.slug}>
            <Link
              href={`/help/${a.slug}`}
              className="group flex h-full flex-col rounded-2xl border border-white/10 bg-white/[0.03] p-5 transition-colors hover:border-white/20 hover:bg-white/[0.05] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/30 motion-reduce:transition-none"
            >
              <span className="text-[15px] font-semibold text-white">{a.title}</span>
              {a.description ? <span className="mt-1.5 text-[13px] leading-5 text-white/55">{a.description}</span> : null}
              <span className="mt-4 text-[12px] font-medium text-white/60 group-hover:text-white">Read →</span>
            </Link>
          </li>
        ))}
      </ol>
    </PublicGuideShell>
  );
}
