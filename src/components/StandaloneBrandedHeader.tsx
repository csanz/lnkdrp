/**
 * Shared top-area branding for "standalone flow" pages (public-ish flows outside the app shell),
 * e.g. billing redirects, request links, doc update links.
 *
 * Matches the unauth home header branding: icon + "LinkDrop" wordmark.
 */
import Image from "next/image";
import Link from "next/link";

export function StandaloneBrandedHeader(props: { kicker?: string; className?: string }) {
  const kicker = (props.kicker ?? "").trim();
  return (
    <header className={props.className ?? ""}>
      <div className="flex h-14 items-center justify-between gap-3 px-3 md:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Link href="/" className="inline-flex items-center gap-2" aria-label="Home" title="LinkDrop">
            <Image src="/icon-white.svg?v=3" alt="LinkDrop" width={32} height={32} priority />
            <span className="text-sm font-semibold tracking-tight text-[var(--fg)]">LinkDrop</span>
          </Link>
        </div>
        {kicker ? (
          <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-2)]">{kicker}</div>
        ) : null}
      </div>
    </header>
  );
}


