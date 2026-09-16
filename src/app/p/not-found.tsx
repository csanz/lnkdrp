/**
 * Project share-page not-found UI for `/p/*`.
 *
 * Shown when the owner turned off "Share enabled" on the project, or the id is invalid. Mirrors
 * `src/app/s/not-found.tsx` so a disabled project link reads the same as a disabled document link.
 */
import BrandHeader from "@/components/BrandHeader";

export default function ProjectShareNotFound() {
  return (
    <main className="min-h-screen bg-black text-white" style={{ backgroundColor: "#000", color: "#fff" }}>
      <BrandHeader />
      <div className="mx-auto w-full max-w-3xl px-6 py-10">
        <div className="text-lg font-semibold tracking-tight text-white/90">This project is no longer shared</div>
        <div className="mt-2 text-sm text-white/70">
          The owner disabled sharing for this project link, or it may be invalid.
        </div>
      </div>
    </main>
  );
}
