"use client";

/**
 * "Introduce yourself", for a data room.
 *
 * The document viewer has asked recipients this for a while; the room's front page never did, and
 * that is where the case is strongest. A visitor can open a data room, read the file list and
 * leave — a visit that writes no reading at all — so the owner's one record of them is a nameless
 * arrival. This is the only chance to put a name on it.
 *
 * It is a sibling of the viewer's modal rather than the same component: the identity they store is
 * shared (`@/lib/share/viewerProfile`, one scope, one pair of normalizers, so answering here means
 * never being asked inside a document of this same sender's), but the words are not. "The owner of
 * this document sees who opened it" is the wrong sentence on a page listing eleven files, and a
 * recipient reads the sentence, not the component tree.
 *
 * The scope matters: the stored identity used to live under one origin-wide key, so answering here
 * also answered for every unrelated sender whose link this browser opened next. It is now keyed on
 * the workspace (`ownerKey`), falling back to this link while that key is still being plumbed
 * through — see `@/lib/share/viewerProfile`.
 */
import { useEffect, useMemo, useState } from "react";

import Modal from "@/components/modals/Modal";
import { getOrCreateBotId } from "@/lib/botId";
import {
  clearShareViewerProfile,
  normalizeShareViewerEmail,
  normalizeShareViewerName,
  readShareViewerProfile,
  readShareViewerProfilePrefill,
  writeShareViewerProfile,
  type ShareViewerProfile,
  type ShareViewerScope,
} from "@/lib/share/viewerProfile";

export default function IntroduceYourself({
  shareId,
  projectName,
  ownerKey = null,
}: {
  shareId: string;
  projectName: string;
  /** The workspace that owns this room, when the page has it: what the stored identity is keyed on. */
  ownerKey?: string | null;
}) {
  const [profile, setProfile] = useState<ShareViewerProfile | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Set once the answer is stored, which turns the modal into a confirmation rather than closing it.
   *
   * Closing on save was the whole acknowledgement: the recipient handed over their name and the
   * box vanished, which reads as a form that may or may not have worked. Someone who has just
   * decided to stop being anonymous is owed the other half of the exchange — what the owner will
   * now see, in the words they typed — before being sent back to what they were reading.
   */
  const [saved, setSaved] = useState<{ name: string | null; email: string } | null>(null);

  const scope: ShareViewerScope = useMemo(() => ({ ownerKey, shareId }), [ownerKey, shareId]);

  // Hydrated in an effect, not at first render: the server has no localStorage, and a button that
  // says "Introduce yourself" on the server and "Viewing as Michael" in the browser is a hydration
  // mismatch.
  //
  // Two different reads on purpose. `profile` is what this room's owner has actually been told, and
  // it alone drives "Viewing as" and the landing POST. The fields may additionally be pre-filled
  // from the identity this browser last saved somewhere else — typing saved, nothing sent, until
  // the recipient presses Save here.
  useEffect(() => {
    const stored = readShareViewerProfile(scope);
    const prefill = stored ?? readShareViewerProfilePrefill();
    setProfile(stored);
    setName(prefill?.name ?? "");
    setEmail(prefill?.email ?? "");
  }, [scope]);

  const previewName = useMemo(() => (name ? normalizeShareViewerName(name) : null), [name]);
  const previewEmail = useMemo(() => (email ? normalizeShareViewerEmail(email) : null), [email]);
  const known = profile?.name || profile?.email || null;

  async function save() {
    const cleanEmail = normalizeShareViewerEmail(email) ?? "";
    const cleanName = normalizeShareViewerName(name);
    if (!cleanEmail) {
      setError("Please enter a valid email.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Stored first: the recipient has answered, and that is true whether or not the network is.
      writeShareViewerProfile(scope, { name: cleanName, email: cleanEmail });
      setProfile({ ...(cleanName ? { name: cleanName } : {}), email: cleanEmail });
      const botId = getOrCreateBotId();
      if (botId) {
        await fetch(`/api/share/${encodeURIComponent(shareId)}/landing`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ botId, viewerEmail: cleanEmail, ...(cleanName ? { viewerName: cleanName } : {}) }),
        }).catch(() => {
          // Never surface an analytics failure to a recipient; the answer is stored either way and
          // rides along with the next request this browser makes.
        });
      }
      setSaved({ name: cleanName, email: cleanEmail });
    } finally {
      setBusy(false);
    }
  }

  /** Dismiss the modal and forget the confirmation, so the next open starts on the form. */
  function dismiss() {
    if (busy) return;
    setOpen(false);
    setError(null);
    setSaved(null);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        className="inline-flex max-w-[50vw] items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-[13px] font-medium text-white/85 hover:bg-white/10"
      >
        {known ? (
          <>
            <span
              aria-hidden="true"
              className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-white text-[10px] font-semibold text-black"
            >
              {(profile?.name ?? profile?.email ?? "?").trim().charAt(0).toUpperCase()}
            </span>
            <span className="min-w-0 truncate">Viewing as {profile?.name ?? profile?.email}</span>
          </>
        ) : (
          "Introduce yourself"
        )}
      </button>

      <Modal
        open={open}
        onClose={dismiss}
        ariaLabel="Introduce yourself"
        panelClassName="w-[min(680px,calc(100vw-32px))] border-white/15 bg-black/95 text-white ring-white/15"
        contentClassName="px-6 pb-6 pt-5"
      >
        {saved ? (
          <>
            <div className="pr-10">
              <div className="text-base font-semibold text-white">Thank you</div>
              <div className="mt-2 text-sm leading-6 text-white/70">
                {projectName ? (
                  <>
                    The owner of <span className="font-semibold text-white/90">{projectName}</span> can see who is here
                    now.
                  </>
                ) : (
                  "The owner of this data room can see who is here now."
                )}{" "}
                Everything you open from here is attributed to you.
              </div>
            </div>

            {/* The same row the form previewed, now as fact rather than a preview. Showing the
                identity back in their own words is the acknowledgement — "saved" on its own does
                not tell them which of the two fields the owner actually sees. */}
            <div className="mt-5 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3.5">
              <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-white/45">You show up as</div>
              <div className="mt-2.5 flex items-center gap-3">
                <span
                  aria-hidden="true"
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white text-[13px] font-semibold text-black"
                >
                  {(saved.name ?? saved.email).trim().charAt(0).toUpperCase()}
                </span>
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-white">{saved.name || saved.email}</div>
                  {saved.name ? <div className="truncate text-xs text-white/50">{saved.email}</div> : null}
                </div>
              </div>
            </div>

            <div className="mt-4 text-xs leading-5 text-white/55">
              You can change it or clear it any time from &ldquo;Viewing as&rdquo; at the top of this page.
            </div>

            <div className="mt-6 flex justify-end">
              <button
                type="button"
                onClick={dismiss}
                className="rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-black hover:bg-white/90"
              >
                Back to the documents
              </button>
            </div>
          </>
        ) : (
        <>
        <div className="pr-10">
          <div className="text-base font-semibold text-white">Introduce yourself</div>
          <div className="mt-2 text-sm leading-6 text-white/70">
            {projectName ? <span className="font-semibold text-white/90">{projectName}</span> : "This data room"} belongs to
            someone who can see who opened it. Right now your visit reads as{" "}
            <span className="font-semibold text-white/90">anonymous</span>: a count on a chart, with nobody to reply to. Add
            your name and they know who was here, and which files you opened.
          </div>
        </div>

        {/* The same live preview the document viewer shows, for the same reason: "who will see what"
            is the only question a recipient is actually weighing, and it is answered faster by
            showing them the row than by describing it. */}
        <div className="mt-5 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3.5">
          <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-white/45">What the owner sees</div>
          <div className="mt-2.5 flex items-center gap-3">
            <span
              aria-hidden="true"
              className={[
                "grid h-9 w-9 shrink-0 place-items-center rounded-full text-[13px] font-semibold",
                previewName ? "bg-white text-black" : "border border-dashed border-white/25 text-white/40",
              ].join(" ")}
            >
              {previewName ? previewName.trim().charAt(0).toUpperCase() : "?"}
            </span>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-white">{previewName || "Anonymous visitor"}</div>
              <div className="truncate text-xs text-white/50">
                {previewEmail || "No name, no email: just another arrival on the chart"}
              </div>
            </div>
          </div>
        </div>

        {error ? (
          <div className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-100">{error}</div>
        ) : null}

        <div className="mt-5 grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="text-xs font-medium text-white/70" htmlFor="project-intro-name">
                Name (optional)
              </label>
              <input
                id="project-intro-name"
                className="mt-2 w-full rounded-xl border border-white/15 bg-black/40 px-3 py-2 text-sm text-white placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-white/15"
                placeholder="Your name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
                disabled={busy}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-white/70" htmlFor="project-intro-email">
                Email
              </label>
              <input
                id="project-intro-email"
                type="email"
                inputMode="email"
                className="mt-2 w-full rounded-xl border border-white/15 bg-black/40 px-3 py-2 text-sm text-white placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-white/15"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                disabled={busy}
              />
            </div>
          </div>

          <div className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3">
            <div className="text-[13px] font-semibold text-white">Or use a free lnkdrp account</div>
            <ul className="mt-1.5 grid gap-1 text-xs leading-5 text-white/60">
              <li>Sign in once and every lnkdrp link you open knows you, with no typing.</li>
              <li>Send your own PDFs as links, and see who read them, which pages, and for how long.</li>
              <li>
                Or let an AI agent do it: Claude, Cursor and other MCP clients can create links and read the stats for you.{" "}
                <a
                  href="/mcp"
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-white/80 underline underline-offset-2 hover:text-white"
                >
                  How that works
                </a>
              </li>
            </ul>
          </div>

          <ul className="grid gap-1.5 text-xs leading-5 text-white/60">
            <li className="flex gap-2">
              <span aria-hidden="true" className="text-white/35">
                ·
              </span>
              <span>Goes to this room&apos;s owner only, with the files you opened. It is never published on the page.</span>
            </li>
            <li className="flex gap-2">
              <span aria-hidden="true" className="text-white/35">
                ·
              </span>
              <span>They can reply to you about these documents, and send you newer versions when they change.</span>
            </li>
            <li className="flex gap-2">
              <span aria-hidden="true" className="text-white/35">
                ·
              </span>
              {/* "Clear" stops this browser sending the name again; it does not reach back into
                  what the owner has already been told. Saying otherwise promised a retraction the
                  product does not offer. */}
              <span>
                Change it any time from &ldquo;Viewing as&rdquo; at the top of this page. Clearing it stops this browser
                sending it again. What you have already shared stays with the owner.
              </span>
            </li>
          </ul>
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          {known ? (
            <button
              type="button"
              className="rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-semibold text-white hover:bg-white/10 disabled:opacity-60"
              disabled={busy}
              onClick={() => {
                clearShareViewerProfile(scope);
                setProfile(null);
                setName("");
                setEmail("");
                setError(null);
                setOpen(false);
              }}
            >
              Clear
            </button>
          ) : (
            <button
              type="button"
              className="rounded-xl px-2 py-2.5 text-sm font-medium text-white/50 hover:text-white/80 disabled:opacity-60"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                setError(null);
              }}
            >
              Stay anonymous
            </button>
          )}
          <button
            type="button"
            className="rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-black hover:bg-white/90 disabled:opacity-60"
            disabled={busy}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
        </>
        )}
      </Modal>
    </>
  );
}
