/**
 * Project share-page not-found UI for `/p/*`.
 *
 * Shown when the owner turned off "Share enabled" on the project, or the id is invalid. Mirrors
 * `src/app/s/not-found.tsx` so a disabled project link reads the same as a disabled document link.
 */
import Image from "next/image";
import Link from "next/link";

export default function ProjectShareNotFound() {
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
        <div className="text-lg font-semibold tracking-tight text-white/90">This project is no longer shared</div>
        <div className="mt-2 text-sm text-white/70">
          The owner disabled sharing for this project link, or it may be invalid.
        </div>
      </div>
    </main>
  );
}
