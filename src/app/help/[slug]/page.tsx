/**
 * `/help/[slug]` — one help article, statically generated per file in `src/content/help`.
 *
 * The body is Markdown rendered by `HelpMarkdown`; the footer of every article offers the chat
 * so a reader who did not find the answer is one click from a person. Unknown slugs 404.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import PublicGuideShell from "@/components/connect/PublicGuideShell";
import HelpMarkdown from "@/components/help/HelpMarkdown";
import SupportLink from "@/components/support/SupportLink";
import { getHelpArticle, listHelpArticles } from "@/lib/help/articles";

type Params = { slug: string };

/** One static page per article. */
export function generateStaticParams(): Params[] {
  return listHelpArticles().map((a) => ({ slug: a.slug }));
}

export const dynamicParams = false;

/** Title and description from the article's front matter. */
export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await params;
  const article = getHelpArticle(slug);
  if (!article) return {};
  return {
    title: article.title,
    description: article.description || undefined,
    alternates: { canonical: `/help/${article.slug}` },
    openGraph: { title: `${article.title} - LinkDrop`, description: article.description || undefined, type: "article" },
  };
}

/** Render the article, or 404 for an unknown slug. */
export default async function HelpArticlePage({ params }: { params: Promise<Params> }) {
  const { slug } = await params;
  const article = getHelpArticle(slug);
  if (!article) notFound();

  const all = listHelpArticles();
  const idx = all.findIndex((a) => a.slug === article.slug);
  const prev = idx > 0 ? all[idx - 1] : null;
  const next = idx >= 0 && idx < all.length - 1 ? all[idx + 1] : null;

  return (
    <PublicGuideShell>
      <Link href="/help" className="text-[12px] font-medium text-white/50 underline-offset-4 hover:text-white hover:underline">
        ← All articles
      </Link>
      <p className="mb-4 mt-6 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/55">Help</p>
      <h1 className="font-serif text-4xl leading-[1.05] tracking-tight text-white sm:text-5xl">{article.title}</h1>
      {article.description ? <p className="mt-5 max-w-xl text-sm leading-6 text-white/60 sm:text-base">{article.description}</p> : null}

      <article className="mt-10">
        <HelpMarkdown>{article.body}</HelpMarkdown>
      </article>

      <div className="mt-14 rounded-2xl border border-white/10 bg-white/[0.03] p-6">
        <p className="text-sm leading-6 text-white/70">
          Still stuck?{" "}
          <SupportLink className="font-medium text-white underline-offset-4 hover:underline">Talk to us</SupportLink>. We reply within a
          business day.
        </p>
      </div>

      <nav aria-label="More articles" className="mt-8 flex flex-wrap justify-between gap-4 text-[13px]">
        {prev ? (
          <Link href={`/help/${prev.slug}`} className="text-white/60 underline-offset-4 hover:text-white hover:underline">
            ← {prev.title}
          </Link>
        ) : (
          <span />
        )}
        {next ? (
          <Link href={`/help/${next.slug}`} className="text-white/60 underline-offset-4 hover:text-white hover:underline">
            {next.title} →
          </Link>
        ) : null}
      </nav>
    </PublicGuideShell>
  );
}
