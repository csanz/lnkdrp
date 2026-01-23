/**
 * Share-page not-found UI for `/s/*`.
 *
 * Shows a friendly message when a share link is disabled or invalid.
 */
import Image from "next/image";
import Link from "next/link";

export default function ShareNotFound() {
  return (
    <main className="min-h-screen bg-black text-white" style={{ backgroundColor: "#000", color: "#fff" }}>
      <header className="sticky top-0 z-10 border-b border-white/10 bg-black/80 backdrop-blur">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-6 py-4">
          <Link href="/" className="inline-flex items-center gap-2" aria-label="Home">
            <Image src="/icon-white.svg?v=3" alt="LinkDrop" width={28} height={28} priority className="block" />
          </Link>
          <div className="text-sm font-semibold text-white/90">LinkDrop</div>
        </div>
      </header>
      <div className="mx-auto w-full max-w-3xl px-6 py-10">
        <div className="text-lg font-semibold tracking-tight text-white/90">This document is no longer shared</div>
        <div className="mt-2 text-sm text-white/70">
          The owner disabled sharing for this link, or it may be invalid.
        </div>
      </div>
    </main>
  );
}

