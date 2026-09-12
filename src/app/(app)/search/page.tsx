/**
 * Page for `/search` (authenticated app shell).
 *
 * URL-backed workspace search across documents and projects (`?q=&scope=&sort=&page=`).
 * The client reads `useSearchParams`, so it is wrapped in a Suspense boundary for prerendering.
 */
import { Suspense } from "react";
import SearchPageClient from "./pageClient";

export default function SearchPage() {
  return (
    <Suspense fallback={null}>
      <SearchPageClient />
    </Suspense>
  );
}
