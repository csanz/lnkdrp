/**
 * The form on `/welcome`. See the page for why there are only two questions.
 *
 * Saving is best-effort per field and never blocks the way in: each call is awaited, a failure is
 * reported, and the screen is still marked done. The alternative — refusing to let someone into
 * their workspace because a preference write failed — trades a small, fixable problem for a total
 * one, and both settings have a home in the dashboard where they can be set again.
 */
"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

import { fetchWithTempUser } from "@/lib/gating/tempUserClient";

type Mode = "immediate" | "daily" | "off";

/** The three answers, in the order someone would consider them. */
const MODES: Array<{ value: Mode; title: string; body: string }> = [
  {
    value: "immediate",
    title: "As it happens",
    body: "An email within a few minutes of someone opening a link, with what they read so far.",
  },
  {
    value: "daily",
    title: "Once a day",
    body: "One summary of everyone who opened something, instead of an email each time.",
  },
  { value: "off", title: "Never", body: "Nothing by email. The metrics pages still record everything." },
];

export default function WelcomeClient({
  firstName,
  lastName,
  email,
}: {
  firstName: string;
  lastName: string;
  email: string;
}) {
  const router = useRouter();
  // `resolvedTheme` is undefined until the client has mounted; picking the black mark until then
  // keeps the server and first client render agreeing, so React does not warn about a mismatch.
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [first, setFirst] = useState(firstName);
  const [last, setLast] = useState(lastName);
  const [mode, setMode] = useState<Mode>("immediate");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function finish(save: boolean) {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const failed: string[] = [];
    if (save) {
      const name = first.trim();
      if (name) {
        const res = await fetchWithTempUser("/api/users/me/name", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ firstName: name, lastName: last.trim() }),
        }).catch(() => null);
        if (!res?.ok) failed.push("your name");
      }
      const res = await fetchWithTempUser("/api/orgs/active/notification-preferences", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ viewEmailMode: mode }),
      }).catch(() => null);
      if (!res?.ok) failed.push("when to email you");
    }
    // Stamped whatever happened above, including on Skip: see `markFirstRunDone`.
    await fetchWithTempUser("/api/users/me/first-run", { method: "POST" }).catch(() => null);
    if (failed.length) {
      setProblem(`Could not save ${failed.join(" or ")}. You can set it in Settings.`);
      setBusy(false);
      return;
    }
    router.push("/upload");
  }

  const field =
    "w-full rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[14px] text-[var(--fg)] outline-none transition-colors focus:border-[var(--muted-2)]";

  return (
    <main className="mx-auto w-full max-w-[640px] px-4 py-12 sm:py-20">
      {/* The mark, and nothing else. This screen is not the app — there is no workspace to
          navigate yet and nowhere to go but forward — so the logo is a signpost saying whose
          product this is, not a link back to somewhere. Without it the first screen of a brand
          new account is an unbranded form.

          Two files rather than one recoloured: the mark is a solid fill, and `icon-white.svg` on
          this page's light background is a white plane on white. The sidebar picks between them
          the same way, on the resolved theme rather than on `prefers-color-scheme`, so an explicit
          light choice inside a dark OS still gets the black one. */}
      <Image
        src={mounted && resolvedTheme === "dark" ? "/icon-white.svg?v=3" : "/icon-black.svg?v=3"}
        alt="LinkDrop"
        width={28}
        height={28}
        priority
        className="mb-8 block"
      />
      <h1 className="text-3xl font-semibold tracking-tight text-[var(--fg)]">Before your first link</h1>
      <p className="mt-2 text-[15px] leading-6 text-[var(--muted)]">
        Two things worth deciding now. Everything else has a sensible default, and all of it lives
        in Settings when you want it.
      </p>

      <section className="mt-10">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.1em] text-[var(--muted-2)]">What should we call you</h2>
        <p className="mt-1.5 text-[13px] leading-5 text-[var(--muted)]">
          This is the name on the documents you share. Not {email ? email : "your sign-in address"},
          unless you want it to be.
        </p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input
            className={field}
            value={first}
            onChange={(e) => setFirst(e.target.value)}
            placeholder="First name"
            aria-label="First name"
            maxLength={60}
            autoFocus
          />
          <input
            className={field}
            value={last}
            onChange={(e) => setLast(e.target.value)}
            placeholder="Last name"
            aria-label="Last name"
            maxLength={60}
          />
        </div>
      </section>

      <section className="mt-10">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.1em] text-[var(--muted-2)]">
          When someone opens what you sent
        </h2>
        <p className="mt-1.5 text-[13px] leading-5 text-[var(--muted)]">
          Knowing while they are still reading is usually the point, so that is the default.
        </p>
        <div className="mt-3 grid gap-2">
          {MODES.map((m) => {
            const active = mode === m.value;
            return (
              <button
                key={m.value}
                type="button"
                onClick={() => setMode(m.value)}
                aria-pressed={active}
                className={[
                  "rounded-xl border px-4 py-3 text-left transition-colors",
                  active
                    ? "border-emerald-600/50 bg-emerald-500/5 dark:border-emerald-300/40"
                    : "border-[var(--border)] bg-[var(--panel)] hover:bg-[var(--panel-hover)]",
                ].join(" ")}
              >
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className={[
                      "inline-block h-2 w-2 shrink-0 rounded-full",
                      active ? "bg-emerald-500 dark:bg-emerald-400" : "bg-[var(--border)]",
                    ].join(" ")}
                  />
                  <span className="text-[14px] font-medium text-[var(--fg)]">{m.title}</span>
                </span>
                <span className="mt-1 block pl-4 text-[13px] leading-5 text-[var(--muted)]">{m.body}</span>
              </button>
            );
          })}
        </div>
      </section>

      {problem ? <p className="mt-6 text-[13px] text-[var(--plan-ending-fg)]">{problem}</p> : null}

      <div className="mt-10 flex items-center gap-4">
        <button
          type="button"
          onClick={() => void finish(true)}
          disabled={busy}
          className="rounded-lg bg-[var(--fg)] px-4 py-2 text-[14px] font-medium text-[var(--bg)] transition-opacity disabled:opacity-60"
        >
          {busy ? "Saving…" : "Share my first document"}
        </button>
        <button
          type="button"
          onClick={() => void finish(false)}
          disabled={busy}
          className="text-[13px] text-[var(--muted)] underline-offset-4 transition-colors hover:text-[var(--fg)] hover:underline disabled:opacity-60"
        >
          Skip for now
        </button>
      </div>
    </main>
  );
}
