/**
 * The pathname part of an `href`: what `usePathname()` reports once the link has been followed.
 *
 * The navigation overlay in `src/app/providers.tsx` is released by a pathname change, so a link
 * that only changes the hash or the query (the History page's `#v-3` chips) must not show it. The
 * old check compared the whole href to the pathname, so those links raised an overlay that nothing
 * released.
 */
export function navPathOf(href: string): string {
  return href.split(/[?#]/, 1)[0];
}
