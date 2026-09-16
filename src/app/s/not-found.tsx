/**
 * Share-page not-found UI for `/s/*`.
 *
 * Shows a friendly message when a share link is disabled or invalid.
 */
import BrandHeader from "@/components/BrandHeader";

export default function ShareNotFound() {
  return (
    <main className="min-h-screen bg-black text-white" style={{ backgroundColor: "#000", color: "#fff" }}>
      <BrandHeader />
      <div className="mx-auto w-full max-w-3xl px-6 py-10">
        <div className="text-lg font-semibold tracking-tight text-white/90">This document is no longer shared</div>
        <div className="mt-2 text-sm text-white/70">
          The owner disabled sharing for this link, or it may be invalid.
        </div>
      </div>
    </main>
  );
}

