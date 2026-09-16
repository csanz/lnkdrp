/**
 * BrandHeader — the one top bar for every standalone page outside the app shell: the share viewer
 * (`/s/:shareId`), its password gate, project share pages, download/invite/request links, billing
 * redirects, login and error pages.
 *
 * Logo on the left, the page's own controls on the right when it has any. A page with nothing to
 * put there still renders the same bar at the same height (71px: the row is held at the height of
 * the viewer's control pill), so moving from a password gate into the viewer, or from an invite
 * into the app, never shifts the logo or the content under it. The marketing pages keep their
 * transparent `PublicHeader`, which uses the same padding and logo size.
 */
import Image from "next/image";
import Link from "next/link";
import type { ReactNode, Ref } from "react";

export default function BrandHeader({
  ref,
  left,
  children,
  logoHref,
}: {
  ref?: Ref<HTMLElement>;
  /** Controls placed right after the logo (the viewer's Summary/History pill). */
  left?: ReactNode;
  /** Right-aligned controls; omit on pages that have none. */
  children?: ReactNode;
  /**
   * Makes the logo a link. Left off on recipient-facing pages (share viewer, password gate,
   * project share): someone reading a shared deck shouldn't be one stray click from our homepage.
   */
  logoHref?: string;
}) {
  const logo = <Image src="/icon-white.svg?v=3" alt="" width={26} height={26} priority className="block" />;
  return (
    <header ref={ref} className="sticky top-0 z-20 w-full border-b border-white/10 bg-black/85 text-white/90 backdrop-blur-sm">
      <div className="px-4 py-3 sm:px-6">
        <div className="flex min-h-[46px] items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            {logoHref ? (
              <Link href={logoHref} aria-label="LinkDrop home" title="LinkDrop" className="inline-flex shrink-0 items-center justify-center">
                {logo}
              </Link>
            ) : (
              <div aria-hidden="true" className="inline-flex shrink-0 items-center justify-center">
                {logo}
              </div>
            )}
            {left}
          </div>
          {children}
        </div>
      </div>
    </header>
  );
}
