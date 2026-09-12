/**
 * About page.
 *
 * Lightweight static copy explaining what LinkDrop is, under the shared public header.
 */
import AboutCopy from "@/components/AboutCopy";
import PublicFooter from "@/components/PublicFooter";
import PublicHeader from "@/components/PublicHeader";
/**
 * Render the AboutPage UI.
 */
export default function AboutPage() {
  return (
    <main className="relative min-h-[100svh] w-full overflow-hidden bg-[#050506] text-white">
      {/* Soft lighting background effect */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(1200px 700px at 80% 20%, rgba(255,255,255,0.10), rgba(255,255,255,0) 60%), radial-gradient(900px 500px at 20% 60%, rgba(255,255,255,0.06), rgba(255,255,255,0) 55%), radial-gradient(700px 500px at 60% 85%, rgba(255,255,255,0.05), rgba(255,255,255,0) 60%)",
        }}
      />

      {/* Content overlay */}
      <div className="relative z-10 min-h-[100svh] w-full">
        <PublicHeader />

        {/* Page is always dark → pin the theme vars AboutCopy reads so Light theme stays readable. */}
        <div className="mx-auto w-full max-w-3xl px-6 pb-12 pt-12 md:pt-16 [--fg:#e7e7ea] [--muted:#b3b3bb]">
          <h1 className="mb-6 text-3xl font-semibold tracking-tight text-white">About</h1>
          <AboutCopy />
        </div>
        <PublicFooter className="relative pb-6" containerClassName="mx-auto w-full max-w-3xl px-6" />
      </div>
    </main>
  );
}
