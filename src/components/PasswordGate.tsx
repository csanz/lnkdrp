"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import BrandHeader from "@/components/BrandHeader";
import type { ShareWorkspaceBrand } from "@/lib/share/brand";
import { fetchJson } from "@/lib/http/fetchJson";
import { getOrCreateBotId } from "@/lib/botId";

/** What the gate stands in front of, or `null` for "say nothing about it". */
type GateScope = "document" | "project";

/**
 * Which kind of thing is behind the password, read off the route the gate was rendered on.
 *
 * `scope` was added to fix the room wording and then never passed by a single caller, so every gate
 * in the product fell through to "Enter the password to continue.": `/p/` stopped being wrong and
 * `/s/` stopped being right, and the branch that says either was dead in production. Handing the
 * three pages the prop fixes today's copy and leaves the fourth page to forget it, which is exactly
 * the arrangement this component already refuses for `title` and `previewUrl` — the reasoning above
 * applies unchanged, so the answer lives here too.
 *
 * The route can answer it and no caller has to: `/s/:shareId` is one document, `/p/:shareId` is the
 * room, `/p/:shareId/:docId` is one document inside it. Nothing is disclosed by reading it — the
 * recipient has the URL in their address bar, which is how they got here. A path this function does
 * not recognise stays `null` rather than guessing, and `scope` still overrides it for a caller that
 * knows better than the URL does.
 */
function scopeFromPath(pathname: string | null | undefined): GateScope | null {
  const [prefix, shareId, docId] = (pathname ?? "").split("/").filter(Boolean);
  if (!shareId) return null;
  if (prefix === "s") return "document";
  // A deep link to one document in a room is still one document, and saying so confirms nothing
  // about the room's contents: the gate goes up before the room is asked whether it holds this id
  // (see the ordering note in `/p/[shareId]/[docId]/page.tsx`), so the wording is identical for an
  // id that is in there and one that is not.
  if (prefix === "p") return docId ? "document" : "project";
  return null;
}

/**
 * Password gate for share pages — a document link's (`/s/:shareId`) and a data room's (`/p/...`).
 *
 * Prompts for a share password and calls `/api/share/:shareId/unlock` to set an auth cookie.
 *
 * **Nothing about what is behind the password is rendered here.** That used to be each caller's
 * job — the gate showed `title` and `previewUrl` when it was given them, and every page passed
 * `title={null} previewUrl={null}` with a comment explaining why — which made it one forgotten prop
 * away from failing. In front of a data room it fails worse than in front of a document: a title
 * and a cover there belong to *one of the documents in the room*, so the gate would answer "which
 * documents are in here" for a stranger who never gave the password, which is the inventory the
 * room's own page goes out of its way to withhold. So the withholding lives in the component now
 * and the two props are accepted but never read, which keeps the existing callers compiling and
 * leaves no way for a new one to reintroduce the leak.
 */
export default function PasswordGate({
  shareId,
  scope,
  workspace,
}: {
  shareId: string;
  /**
   * Accepted and ignored — see above. Kept in the signature so the callers that pass `null` today
   * (`/s/:shareId`, `/p/:shareId`, `/p/:shareId/:docId`) keep type-checking, and so passing a real
   * one is inert rather than a disclosure.
   */
  title?: string | null;
  /** Accepted and ignored — see above. */
  previewUrl?: string | null;
  /**
   * What is behind the password, for the wording only. A data room is several documents, so "Enter
   * the password to view this document" was simply wrong there. Optional and normally left unset:
   * the route already says which one it is, and `scopeFromPath` reads it there so that no page has
   * to remember. Pass it only to override that, and `null` to say nothing at all.
   */
  scope?: GateScope | null;
  /**
   * The workspace that shared this. Shown here on purpose, and it is the one thing on this page
   * that is: the gate withholds the name and the cover of whatever is behind it (see above), but
   * an unsigned box demanding a password is also precisely what a phishing page looks like. Naming
   * the sender is what tells a recipient the prompt is the one they were expecting — and the
   * sender's identity is already known to whoever was sent the link, where the contents are the
   * thing the password was set to protect.
   */
  workspace?: ShareWorkspaceBrand | null;
}) {
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // What the password is in front of, in words that are true before it has been given: one
  // document, or a room of them. Nothing here names either of them. An explicit `scope` wins,
  // including an explicit `null` for "do not say"; leaving it off asks the route (see above).
  const pathname = usePathname();
  const behind = scope === undefined ? scopeFromPath(pathname) : scope;
  const behindTheGate = behind === "project" ? "this data room" : behind === "document" ? "this document" : null;

  async function unlock() {
    setSubmitting(true);
    setError(null);
    try {
      await fetchJson(`/api/share/${shareId}/unlock`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The device id goes with it so the unlock lands in the owner's feed as the same person who
        // then reads the document, rather than as a second, anonymous someone.
        body: JSON.stringify({ password, botId: getOrCreateBotId() }),
      });
      // Cookie is set by the API; re-render server component with auth.
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to unlock");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    // Always dark, like the viewer this gate stands in front of: unlocking swaps the card for the
    // document under the same header, so the page shouldn't also flip from light to black.
    <main
      className="min-h-screen bg-[var(--bg)] text-[var(--fg)]"
      style={
        {
          colorScheme: "dark",
          "--bg": "#000",
          "--fg": "#e7e7ea",
          "--panel": "#111113",
          "--panel-2": "#151518",
          "--border": "#2a2a31",
          "--muted": "#b3b3bb",
          "--muted-2": "#8b8b96",
          "--ring": "rgba(255,255,255,0.25)",
          "--primary-bg": "#fff",
          "--primary-fg": "#000",
          "--primary-hover-bg": "rgba(255,255,255,0.9)",
        } as React.CSSProperties
      }
    >
      <BrandHeader workspace={workspace ?? null} />
      <div className="mx-auto flex w-full max-w-md flex-col items-center px-6 py-12 sm:py-16">
        <div className="w-full rounded-3xl border border-[var(--border)] bg-[var(--panel)] p-6 shadow-sm">
          <div className="text-base font-semibold text-[var(--fg)]">Password required</div>
          <div className="mt-2 text-sm text-[var(--muted)]">
            {behindTheGate ? `Enter the password to view ${behindTheGate}.` : "Enter the password to continue."}
          </div>

          <div className="mt-5">
            <label className="text-xs font-medium text-[var(--muted-2)]" htmlFor="share-password">
              Password
            </label>
            <input
              id="share-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                if (!password.trim() || submitting) return;
                void unlock();
              }}
              className="mt-2 h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 text-sm text-[var(--fg)] placeholder:text-[var(--muted-2)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
              placeholder="Enter password"
              autoComplete="current-password"
              autoFocus
            />
          </div>

          {error ? (
            <div className="mt-4 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-100/90">
              {error}
            </div>
          ) : null}

          <div className="mt-5 flex items-center justify-end">
            <button
              type="button"
              onClick={() => void unlock()}
              disabled={!password.trim() || submitting}
              className="inline-flex items-center justify-center rounded-lg bg-[var(--primary-bg)] px-4 py-2 text-sm font-semibold text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? "Unlocking…" : "Unlock"}
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}



