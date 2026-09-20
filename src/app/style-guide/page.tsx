/**
 * `/style-guide` — the index of design previews.
 *
 * Previews are throwaway pages built to settle one decision by looking at it instead of arguing
 * about it: real component markup, real widths, fake data. They live here rather than at the root
 * so the app does not collect a page per spike, and each one says what it is for and when it can
 * go. Nothing here is linked from the product.
 */
import Link from "next/link";

const PREVIEWS: Array<{ href: string; title: string; blurb: string; status: string }> = [
  {
    href: "/style-guide/tags",
    title: "Tags in the left menu",
    blurb: "Tag pill versus tag dot on project rows, at the sidebar's real width, with short and long project names, plus the Tags section that makes a dot legible.",
    status: "Open, awaiting a decision (docs/prds/lnkdrp-tags.md)",
  },
];

export const metadata = { title: "Style guide", robots: { index: false, follow: false } };

export default function StyleGuideIndexPage() {
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <h1 className="text-lg font-semibold tracking-tight text-[var(--fg)]">Style guide</h1>
      <p className="mt-1 text-[13px] leading-5 text-[var(--muted)]">
        Design previews: real markup, real widths, fake data. Not linked from the product, and each one is deletable once the
        decision it exists for has been made.
      </p>

      <ul className="mt-8 grid gap-3">
        {PREVIEWS.map((p) => (
          <li key={p.href}>
            <Link
              href={p.href}
              className="block rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5 transition-colors hover:bg-[var(--panel-hover)]"
            >
              <div className="text-[15px] font-semibold text-[var(--fg)]">{p.title}</div>
              <p className="mt-1 text-[13px] leading-5 text-[var(--muted)]">{p.blurb}</p>
              <div className="mt-3 text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--muted-2)]">{p.status}</div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
