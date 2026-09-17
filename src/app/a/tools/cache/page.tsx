/**
 * Admin Tools: Cache inspector + clear utility.
 *
 * Route: `/a/tools/cache`
 * Shows current client-side localStorage cache entries (best-effort) and allows clearing them.
 */
import CacheToolsClient from "@/admin/components/CacheToolsClient";
import { ADMIN_PAGE_CONTAINER } from "@/lib/admin/layout";

export default function AdminCacheToolsPage() {
  return (
    <div className={ADMIN_PAGE_CONTAINER}>
      <div className="mb-6">
        <div className="text-base font-semibold text-[var(--fg)]">Admin / Tools / Cache</div>
        <p className="mt-2 text-sm leading-6 text-[var(--muted)]">Inspect and clear local client-side caches.</p>
      </div>
      <CacheToolsClient />
    </div>
  );
}


