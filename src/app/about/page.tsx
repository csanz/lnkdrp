/**
 * About page.
 *
 * Same frame as the logged-out homepage (`HomeUnauthedClient`): the paper plane + globe animation
 * behind the first viewport on desktop, the same soft lighting, the same content column and
 * serif headline, so moving between "/" and "/about" feels like one site. The copy itself is the
 * shared `AboutCopy` (the account menu links here), pinned to the homepage's white-on-dark
 * tones.
 */
import AboutCopy from "@/components/AboutCopy";
import PublicFooter from "@/components/PublicFooter";
import PublicHeader from "@/components/PublicHeader";

/**
 * Render the AboutPage UI.
 */
export default function AboutPage() {
  return (
    <main className="relative min-h-[100svh] w-full overflow-x-hidden bg-[#050506] text-white">
      {/* Full-bleed animation background (visual only), framed to the first viewport exactly as on
          the homepage so the plane sits beside the headline. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 hidden h-[100svh] md:block">
        <iframe
          title="Paperplane animation"
          src="/paperplane/index.html"
          className="h-full w-full border-0"
          loading="eager"
          referrerPolicy="no-referrer"
        />
        <div className="absolute inset-x-0 bottom-0 h-[14svh] bg-gradient-to-t from-[#050506] to-transparent" />
      </div>

      {/* Soft lighting on top of the animation (desktop), same pools as the homepage. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(1200px 700px at 80% 20svh, rgba(255,255,255,0.10), rgba(255,255,255,0) 60%), radial-gradient(900px 500px at 20% 60svh, rgba(255,255,255,0.06), rgba(255,255,255,0) 55%), radial-gradient(700px 500px at 60% calc(100svh + 40px), rgba(255,255,255,0.05), rgba(255,255,255,0) 60%)",
        }}
      />
      {/* Mobile lighting (no animation behind the hero on phones). */}
      <div
        className="pointer-events-none absolute inset-0 md:hidden"
        style={{
          background:
            "radial-gradient(90vw 70vw at 100% 0%, rgba(255,255,255,0.14), rgba(255,255,255,0) 65%), radial-gradient(70vw 50vw at 100% 70%, rgba(255,255,255,0.05), rgba(255,255,255,0) 60%), radial-gradient(110vw 80vw at 0% 100%, rgba(255,255,255,0.06), rgba(255,255,255,0) 60%)",
        }}
      />

      {/* Overlay (real HTML text) */}
      <div className="relative z-10 flex min-h-[100svh] w-full flex-col">
        <PublicHeader />

        <section className="mx-auto w-full max-w-6xl flex-1 px-8 pb-24 pt-12 sm:px-10 md:pt-16 lg:px-12">
          {/* Same column as the hero so the plane has the same room to its right. */}
          <div className="w-full md:w-[min(560px,54%)] [--fg:#ffffff] [--muted:rgba(255,255,255,0.6)]">
            <p className="mb-4 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/55">About</p>
            <h1 className="font-serif text-5xl leading-[1.02] tracking-tight text-white sm:text-6xl md:text-[56px] lg:text-[64px]">
              Share links built for the way work happens now
            </h1>

            <div className="mt-8 max-w-lg text-sm sm:text-base [&_p]:leading-6 [&_.text-xs]:text-[13px] [&_.text-xs]:leading-6">
              <AboutCopy />
            </div>
          </div>
        </section>

        {/* Mobile: the plane and globe live in a short frame at the end of the page instead of behind the hero. */}
        <div aria-hidden="true" className="relative -mt-6 h-[64svh] min-h-[360px] w-full [mask-image:linear-gradient(to_bottom,transparent,#000_6rem)] md:hidden">
          <iframe
            title=""
            tabIndex={-1}
            src="/paperplane/index.html?yfrac=0.38&xfrac=0&minaspect=0.5"
            className="pointer-events-none absolute inset-0 h-full w-full border-0"
            loading="lazy"
            referrerPolicy="no-referrer"
          />
          <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-[#050506] to-transparent" />
        </div>

        <PublicFooter className="relative bg-[#050506] pb-6 md:bg-transparent" />
      </div>
    </main>
  );
}
