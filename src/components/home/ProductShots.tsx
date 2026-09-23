/**
 * What the product actually looks like, below the hero.
 *
 * The homepage opened on a paper plane and a globe and never showed the product, so a visitor had
 * no way to learn what lnkdrp *is* — and this is a product you can only really explain by showing:
 * the pitch is "you can see that Series A Deck was read to page 12 of 14, by someone who told you
 * who they were", and no sentence beats the screenshot of it.
 *
 * On the effect, deliberately restrained. The reference (Linear) crops its first shot at the fold
 * so the page asks to be scrolled; here the fold already belongs to the globe animation, and a
 * second thing competing for it would make both worse. So these sit below it and arrive on scroll
 * instead: opacity and a short rise, once, on an IntersectionObserver. No pinning, no parallax, no
 * scroll-jacking — the hero already runs a three.js scene in an iframe and the budget is spent.
 *
 * Anyone who has asked not to see motion gets the finished state immediately, with no observer
 * wired up at all.
 */
"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";

type Shot = {
  src: string;
  /** Intrinsic size, so `next/image` reserves the box and the page never jumps as they load. */
  width: number;
  height: number;
  title: string;
  body: string;
  alt: string;
};

/**
 * Four shots, in the order the product actually happens: the agent is given the tools, it sends the
 * link, you see what one recipient did with it, and then the whole workspace's stream — teammates,
 * agents and readers together.
 *
 * The agent comes first because it is the premise — the headline above says "built for AI agents"
 * and the section used to open on a metrics dashboard, so the page argued for itself backwards.
 * It is framed as *what the agent can do*, not as *how to connect it*: the block immediately above
 * this section already shows the `claude mcp add` line and an exchange with the agent, and a
 * screenshot of the same command underneath it would be the page saying one thing twice. The tool
 * list with its read / write / asks-first marks is the part nothing else on the page carries.
 *
 * The activity feed closes it. It was cut once for repeating the other two — its counts echo the
 * metrics shot, its agent attribution echoes the first — and put back because that reading missed
 * what it is actually for: it is the only shot showing a *team*, where a colleague, an agent and a
 * reader all appear in the same stream. The others each show one person alone with the product.
 */
const SHOTS: Shot[] = [
  {
    src: "/images/home/agents.png",
    width: 1743,
    height: 975,
    title: "Your agent gets real tools",
    body: "One key, and your MCP client can share a document, replace the file behind a link, and read the numbers back. The destructive ones ask a human first.",
    alt: "The agents page: a connected key, the one-line MCP command, and the tool list — share, replace, read stats — each marked read, write, or asks first.",
  },
  {
    src: "/images/home/metrics.png",
    width: 1816,
    height: 1069,
    title: "Know who read it",
    body: "Every open is recorded: who came, how long they stayed, how many came back. Not a delivery receipt — a reading report.",
    alt: "The metrics page: recent visitors with read and skimmed badges, views, opens, reading time, and a views-per-day chart.",
  },
  {
    src: "/images/home/reader.png",
    width: 1822,
    height: 1061,
    title: "See how far they got",
    body: "Time on every page, session by session. The difference between a deck that was opened and a deck that was read.",
    alt: "One reader's detail view: sessions, time spent, pages viewed, and a bar of seconds spent on each page.",
  },
  {
    src: "/images/home/activity.png",
    width: 1823,
    height: 1057,
    title: "All of it in one place",
    body: "Your teammates, your agents and your readers, in a single feed. Who shared what, which agent did it, and every open that followed.",
    alt: "The activity feed: documents added, links created and archived, alongside named readers opening documents, attributed to people and to connected agents.",
  },
];

/** One shot in its frame, revealed when it comes into view. */
function ShotFigure({ shot, priority, onOpen }: { shot: Shot; priority: boolean; onOpen: (shot: Shot) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  /**
   * Starts true for anyone who prefers reduced motion, and for a browser with no
   * `IntersectionObserver`, so the content is never hidden behind an effect that will not run.
   */
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
    if (reduced || typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          setShown(true);
          // Once. A figure that re-hides on the way back up turns a page into a toy.
          io.disconnect();
        }
      },
      // Fire a little before the top edge arrives, so the rise finishes as it settles rather than
      // starting once it is already sitting still in the middle of the screen.
      { rootMargin: "0px 0px -12% 0px", threshold: 0.05 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <figure
      ref={ref}
      className={[
        "mt-16 first:mt-0 transition-all duration-700 ease-out motion-reduce:transition-none",
        shown ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0 motion-reduce:translate-y-0 motion-reduce:opacity-100",
      ].join(" ")}
    >
      {/* The frame grew; the prose did not. A caption set to the full width of a 1280px
          screenshot is a 150-character line, which is not a line anyone reads. */}
      <figcaption className="mx-auto max-w-xl text-center">
        <h2 className="font-serif text-3xl leading-tight tracking-tight text-white sm:text-4xl">{shot.title}</h2>
        <p className="mt-3 text-sm leading-6 text-white/60 sm:text-base">{shot.body}</p>
      </figcaption>

      {/*
        The frame. A dark screenshot on a near-black page needs an edge or it bleeds into the
        background, and a shadow alone cannot give it one. `ring-1` over `border` so the 1px sits
        outside the rounded corner and never clips the image; the gradient on top is the light
        falling on the glass, which is what stops it reading as a flat rectangle pasted on.
      */}
      {/*
        A button, not a div with an onClick: this is the one interactive thing in the section, and
        it has to be reachable by keyboard and announced as something that does something.
      */}
      <button
        type="button"
        onClick={() => onOpen(shot)}
        aria-label={`View ${shot.title.toLowerCase()} full size`}
        className="lnk-shot group relative mt-8 block w-full cursor-zoom-in overflow-hidden rounded-2xl ring-1 ring-white/10 shadow-[0_40px_120px_-24px_rgba(0,0,0,0.9)] transition-shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
      >
        <Image
          src={shot.src}
          alt={shot.alt}
          width={shot.width}
          height={shot.height}
          /**
           * Only the first competes with the hero for bandwidth; the other two are eager but
           * unprioritised — but all three load eagerly, which has to be said out loud because
           * `next/image` applies `loading="lazy"` on its own to anything without `priority`.
           *
           * Lazy is wrong here for a reason worth recording: a lazy image resolves `sizes` before
           * layout is known, so the browser picks the largest candidate in the srcset — the third
           * shot was fetching the `w=3840` variant while its siblings took `w=1200`. Three shots
           * at roughly 40KB each is a rounding error on a page that already ships a three.js
           * scene; a 3840px render that arrives after the reader does is not.
           */
          priority={priority}
          loading="eager"
          // One column, capped by the section, so the browser never fetches more than it paints.
          // The prose above stays narrow; only the frame runs the full width.
          sizes="(min-width: 1520px) 1520px, 100vw"
          // Screenshots are not photographs: at the default 75 the compressor spends its budget on
          // the large flat areas and takes it out of the 11px labels, which is the only part of a
          // product shot anyone is trying to read.
          quality={90}
          className="block h-auto w-full"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-gradient-to-b from-white/[0.07] via-transparent to-transparent"
        />
        {/* The only hint that the frame is clickable. Hover-only and unobtrusive: a permanent
            badge on three large images would read as chrome. */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-3 right-3 rounded-lg bg-black/70 px-2 py-1 text-[11px] font-medium text-white/80 opacity-0 ring-1 ring-white/15 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        >
          Click to enlarge
        </span>
      </button>
    </figure>
  );
}

/**
 * The enlarged shot.
 *
 * Deliberately not a pan-and-zoom viewer: that is a lot of surface for a marketing page, and on a
 * touch screen it fights the scroll it is embedded in. This is the whole image, as large as the
 * viewport allows, and a way out.
 *
 * It renders a plain `<img>` against the original file rather than `next/image`. Everywhere else
 * the optimiser is doing useful work; here the entire point is the untouched pixels, and asking the
 * optimiser for a variant larger than the source only gets an upscale of it.
 */
function Lightbox({ shot, onClose }: { shot: Shot; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    // Focus moves into the overlay so the next Tab is inside it, and Escape is the way out
    // everyone tries first.
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);

    // The page behind must not scroll under the overlay. Restored exactly as found, because the
    // homepage sets no overflow of its own and assuming "" would be a guess.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={shot.title}
      // Clicking the backdrop closes. The image sits in its own element so a click that lands on
      // the picture itself does not dismiss the thing the reader just opened.
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4 backdrop-blur-sm sm:p-8"
    >
      <button
        ref={closeRef}
        type="button"
        onClick={onClose}
        className="absolute right-4 top-4 rounded-lg bg-white/10 px-3 py-1.5 text-sm font-medium text-white/90 ring-1 ring-white/15 transition-colors hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
      >
        Close
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element -- the original pixels are the point; see above. */}
      <img
        src={shot.src}
        alt={shot.alt}
        onClick={(e) => e.stopPropagation()}
        className="max-h-full max-w-full cursor-default rounded-xl object-contain ring-1 ring-white/15"
      />
    </div>
  );
}

/** The section itself: three claims, three shots, below the fold. */
export default function ProductShots() {
  const [open, setOpen] = useState<Shot | null>(null);

  return (
    <section
      aria-label="What lnkdrp looks like"
      className="relative z-10 mx-auto w-full max-w-[1520px] px-4 pb-28 pt-8 sm:px-8 md:pt-16 lg:px-12"
    >
      {/*
        The scroll-linked scale.
        
        A screenshot that arrives already at its final size is a picture on a page; one that grows
        the last few percent as it settles reads as the product coming to you, which is the whole
        trick on the page this borrows from. It is deliberately small — 94% to 100% — because the
        version that starts at 80% spends its first half illegible, and an unreadable product shot
        argues for nothing.

        In CSS rather than JavaScript on purpose. `animation-timeline: view()` is driven by the
        compositor, so it costs nothing per frame; the hero above already runs a three.js scene in
        an iframe and a scroll handler here would be competing with it for the main thread. A
        browser without it simply does not run this, and still gets the one-shot reveal the figure
        does in JS — so nothing is ever hidden behind an effect that will not run.

        No pinning and no scroll-jacking. The page stays a page.
      */}
      <style>{`
        @supports (animation-timeline: view()) {
          @media (prefers-reduced-motion: no-preference) {
            .lnk-shot {
              animation: lnk-shot-settle linear both;
              animation-timeline: view();
              /* Done well before it is centred, so it is at full size while it is being read. */
              animation-range: entry 15% cover 35%;
            }
            @keyframes lnk-shot-settle {
              from { transform: scale(0.94); }
              to { transform: scale(1); }
            }
          }
        }
      `}</style>
      {SHOTS.map((shot, i) => (
        <ShotFigure key={shot.src} shot={shot} priority={i === 0} onOpen={setOpen} />
      ))}
      {open ? <Lightbox shot={open} onClose={() => setOpen(null)} /> : null}
    </section>
  );
}
