/**
 * Admin layout constants.
 *
 * Admin pages fill the window: they are dense tables and panels sitting next to a
 * fixed sidebar, so a centred column would leave huge empty gutters on a wide screen.
 * Page-level wrappers use ADMIN_PAGE_CONTAINER and must not re-add `mx-auto` or any
 * `max-w-*`; inner caps that keep a form field or a paragraph readable are fine.
 */

/** Page-level container for every admin page: full width, comfortable side padding. */
export const ADMIN_PAGE_CONTAINER = "w-full px-5 py-8 sm:px-8";
