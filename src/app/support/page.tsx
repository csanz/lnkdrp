/**
 * `/support` — the page a customer lands on to continue a support conversation.
 *
 * Plain emails a customer when a reply arrives after they closed the chat, and the "Reply" button
 * in that email needs a URL where the widget is certain to be present and to open. Every other
 * page either hides the launcher for anonymous visitors or, on recipient routes, does not mount
 * the widget at all. This one always shows it and opens it on arrival (`SupportOpener`), so the
 * person is back in their thread in one click whether or not they are signed in. Signed in,
 * Plain already knows who they are; signed out, Plain verifies them by emailed code.
 *
 * Also a reasonable place to point "support" from anywhere else, which is why it is a real page
 * with a fallback, not a redirect: with the widget unconfigured, it still shows the email.
 */
import type { Metadata } from "next";

import PublicFooter from "@/components/PublicFooter";
import PublicHeader from "@/components/PublicHeader";
import SupportLink from "@/components/support/SupportLink";
import SupportOpener from "@/components/support/SupportOpener";

export const metadata: Metadata = {
  title: "Support",
  description: "Get help with LinkDrop.",
};

/** The support landing page: opens the chat, with email as the fallback. */
export default function SupportPage() {
  return (
    <main className="relative min-h-[100svh] w-full overflow-x-hidden bg-[#050506] text-white">
      <div className="relative z-10 flex min-h-[100svh] w-full flex-col">
        <PublicHeader />
        <section className="mx-auto w-full max-w-6xl flex-1 px-8 pb-24 pt-12 sm:px-10 md:pt-16 lg:px-12">
          <div className="w-full md:w-[min(560px,54%)] [--fg:#ffffff] [--muted:rgba(255,255,255,0.6)]">
            <p className="mb-4 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/55">Support</p>
            <h1 className="font-serif text-5xl leading-[1.02] tracking-tight text-white sm:text-6xl md:text-[56px]">
              We&rsquo;re here.
            </h1>
            <p className="mt-6 text-base leading-7 text-white/70">
              The chat should open on its own. If it hasn&rsquo;t,{" "}
              <SupportLink className="font-semibold text-white underline underline-offset-2">open it here</SupportLink>, or
              email us at{" "}
              <SupportLink className="font-semibold text-white underline underline-offset-2">hi@lnkdrp.com</SupportLink>.
            </p>
            <p className="mt-3 text-sm leading-6 text-white/50">We reply within a business day.</p>
          </div>
        </section>
        <PublicFooter />
      </div>
      <SupportOpener />
    </main>
  );
}
