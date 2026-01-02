/**
 * Admin Tools: Cache inspector + clear utility.
 *
 * Route: `/a/tools/cache`
 * Shows current client-side localStorage cache entries (best-effort) and allows clearing them.
 */
import CacheToolsClient from "@/admin/components/CacheToolsClient";

export default function AdminCacheToolsPage() {
  return (
    <div className="px-6 py-8">
      <div className="mb-6">
        <div className="text-base font-semibold text-[var(--fg)]">Admin / Tools / Cache</div>
        <p className="mt-2 text-sm leading-6 text-[var(--muted)]">Inspect and clear local client-side caches.</p>
      </div>
      <CacheToolsClient />
    </div>
  );
}


