/**
 * Shared footer for public (logged-out) pages: `/`, `/about`, `/pricing`, `/tos`, `/privacy`.
 *
 * One left-aligned cluster: copyright, then the legal links (Terms, Privacy), so the header stays focused on
 * product navigation. `className` positions the footer (the homepage pins it to the bottom of the
 * first viewport); `containerClassName` aligns the inner row with a page's content column.
 */
import Link from "next/link";
import { cn } from "@/lib/cn";

const FOOTER_LINK_CLASS = "transition hover:text-white/70";

/**
 * Render the PublicFooter UI (copyright left, Terms/Privacy right).
 */
export default function PublicFooter({
  className,
  containerClassName,
}: {
  className?: string;
  containerClassName?: string;
} = {}) {
  const year = new Date().getFullYear();
  return (
    <footer className={cn("z-10 text-[11px] font-medium text-white/35", className)}>
      <div className={containerClassName ?? "mx-auto w-full max-w-6xl px-8 sm:px-10 lg:px-12"}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span>© {year} LinkDrop Group</span>
          <span aria-hidden="true" className="text-white/20">·</span>
          <nav aria-label="Legal" className="flex items-center gap-4">
            <Link href="/tos" className={FOOTER_LINK_CLASS}>
              Terms
            </Link>
            <Link href="/privacy" className={FOOTER_LINK_CLASS}>
              Privacy
            </Link>
          </nav>
        </div>
      </div>
    </footer>
  );
}
