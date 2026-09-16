/**
 * 404 for every route, including share, project and request links that no longer resolve.
 * Recipients land here from links someone sent them, so it says that plainly instead of Next's
 * bare default page.
 */
import Link from "next/link";
import BrandHeader from "@/components/BrandHeader";

export default function NotFound() {
  return (
    <main className="flex min-h-[100svh] flex-col bg-[#050506] text-white">
      <BrandHeader logoHref="/" />
      <div className="grid flex-1 place-items-center px-6 py-10">
        <div className="w-full max-w-md rounded-3xl border border-white/10 bg-white/5 px-8 py-7">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/40">404</p>
          <h1 className="mt-2 text-[19px] font-semibold leading-6 tracking-tight">This page doesn’t exist</h1>
          <p className="mt-2 text-sm leading-6 text-white/60">
            If someone sent you this link, it may have been turned off, deleted or mistyped. Ask them for a new one.
          </p>
          <Link
            href="/"
            className="mt-6 inline-flex h-10 items-center justify-center rounded-xl bg-white px-4 text-sm font-semibold text-black shadow-sm transition hover:bg-white/90"
          >
            Go to LinkDrop
          </Link>
        </div>
      </div>
    </main>
  );
}
