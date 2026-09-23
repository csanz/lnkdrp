/**
 * The form on `/welcome`. See the page for why there are so few questions.
 *
 * The AI section is shown rather than asked. Both runs are already on, and the summary is most of
 * what makes a link worth opening, so a brand-new account that switched it off here would judge the
 * product on a version of itself it never saw. What it buys is the absence of a surprise: the first
 * upload spends a credit and writes something, and this is where that was said out loud.
 *
 * Saving is best-effort per field and never blocks the way in: each call is awaited, a failure is
 * reported, and the screen is still marked done. The alternative — refusing to let someone into
 * their workspace because a preference write failed — trades a small, fixable problem for a total
 * one, and both settings have a home in the dashboard where they can be set again.
 *
 * **One question at a time, with a progress bar.** It was a single long scroll of four sections,
 * which reads as a form to fill in before you are allowed in — and a form of unknown length is one
 * people abandon, because there is no way to tell whether it is nearly over. A step counter answers
 * that before the first keystroke, and each step saves as it goes, so leaving halfway keeps what
 * was already answered instead of discarding all of it.
 *
 * Skipping stays available on every step and still stamps the screen done, for the same reason as
 * before. `Back` does not re-save: going back to look at an answer should cost nothing.
 */
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import OnboardingTopBar from "@/components/onboarding/OnboardingTopBar";

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

/**
 * The other end of the visit. Asked right after the open email because the two are a pair — the
 * start and the end of a reading — and someone who wants one email per visit picks this one and
 * turns the other off. Pro only in practice; on Free the choice is stored and waits.
 */
const BRIEF_MODES: Array<{ value: Mode; title: string; body: string }> = [
  {
    value: "immediate",
    title: "After each visit",
    body: "A few minutes after a reader is done: what held them, what they skipped, whether they came back. One credit per visit, on Pro.",
  },
  { value: "daily", title: "Once a day", body: "Every visit of the day and its brief, in one email." },
  { value: "off", title: "Never", body: "The briefs are still written and kept on each reader's page." },
];

/** The steps, in order. `title` is the heading; `label` is what the counter counts. */
const STEP_COUNT = 4;

export default function WelcomeClient({
  firstName,
  lastName,
  email,
  orgId,
}: {
  firstName: string;
  lastName: string;
  email: string;
  /** The workspace that already exists, for step one to rename. */
  orgId: string;
}) {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [workspace, setWorkspace] = useState("");
  const [first, setFirst] = useState(firstName);
  const [last, setLast] = useState(lastName);
  const [mode, setMode] = useState<Mode>("immediate");
  const [briefMode, setBriefMode] = useState<Mode>("immediate");
  const [autoSummary, setAutoSummary] = useState(true);
  const [autoCompare, setAutoCompare] = useState(true);
  const [autoBrief, setAutoBrief] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  /**
   * What each step writes, if anything.
   *
   * Returns the thing that failed, in the words the error message uses, or null. Every one is
   * skippable by leaving it untouched: an empty workspace name, an empty first name and the
   * all-on AI defaults each write nothing, so a person who presses through without typing makes
   * no more requests than the old single screen did.
   */
  async function saveStep(n: number): Promise<string | null> {
    if (n === 1) {
      const name = workspace.trim();
      // Untouched means "Personal", which is what it is already called.
      if (!name) return null;
      const res = await fetchWithTempUser(`/api/orgs/${encodeURIComponent(orgId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      }).catch(() => null);
      return res?.ok ? null : "your workspace name";
    }
    if (n === 2) {
      const name = first.trim();
      if (!name) return null;
      const res = await fetchWithTempUser("/api/users/me/name", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ firstName: name, lastName: last.trim() }),
      }).catch(() => null);
      return res?.ok ? null : "your name";
    }
    if (n === 3) {
      const res = await fetchWithTempUser("/api/orgs/active/notification-preferences", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ viewEmailMode: mode, briefEmailMode: briefMode }),
      }).catch(() => null);
      return res?.ok ? null : "when to email you";
    }
    // All three already default to on server-side, so the untouched case writes nothing.
    if (autoSummary && autoCompare && autoBrief) return null;
    const aiRes = await fetchWithTempUser("/api/credits/quality-defaults", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // The route requires both tiers, and this screen deliberately does not ask about quality.
      // Posting the same defaults the workspace already resolves to keeps the write to the two
      // fields this screen is actually about.
      body: JSON.stringify({
        reviewQualityTier: "standard",
        historyQualityTier: "basic",
        autoSummary,
        autoCompare,
        autoBrief,
      }),
    }).catch(() => null);
    return aiRes?.ok ? null : "your AI settings";
  }

  /** Save this step, then move on — or, on the last one, into the app. */
  async function advance() {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const failed = await saveStep(step);
    if (failed) {
      // Stay put rather than carrying the problem forward: the field that failed is on this screen.
      setProblem(`Could not save ${failed}. You can set it in Settings.`);
      setBusy(false);
      return;
    }
    if (step < STEP_COUNT) {
      setStep(step + 1);
      setBusy(false);
      return;
    }
    await fetchWithTempUser("/api/users/me/first-run", { method: "POST" }).catch(() => null);
    router.push("/upload");
  }

  /** Leave now. Whatever earlier steps saved is kept; this one is not. */
  async function skip() {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    // Stamped whatever happened above, including on Skip: see `markFirstRunDone`.
    await fetchWithTempUser("/api/users/me/first-run", { method: "POST" }).catch(() => null);
    router.push("/upload");
  }

  const field =
    "w-full rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[14px] text-[var(--fg)] outline-none transition-colors focus:border-[var(--muted-2)]";

  return (
    <>
      <OnboardingTopBar email={email} progress={step / STEP_COUNT} />
      <main className="mx-auto w-full max-w-[640px] px-4 py-12 sm:py-20">
      {/* How far along, in words. The line itself is in the top bar, spanning the viewport, so it
          reads as progress through the page rather than as a rule inside this column. */}
      <p
        className="mb-8 font-mono text-[12px] tracking-[0.08em] text-[var(--muted-2)]"
        role="status"
        aria-live="polite"
      >
        Step {step} of {STEP_COUNT}
      </p>

      {step === 1 ? (
        <section>
          <h1 className="text-3xl font-semibold tracking-tight text-[var(--fg)]">Name your workspace</h1>
          <p className="mt-2 text-[15px] leading-6 text-[var(--muted)]">
            A workspace holds your documents, links and analytics. This name goes on your invoices
            and is what teammates see when you invite them.
          </p>
          <div className="mt-6">
            <label htmlFor="workspace-name" className="block text-[13px] font-medium text-[var(--fg)]">
              Workspace name
            </label>
            <p className="mt-1 text-[13px] leading-5 text-[var(--muted)]">
              Most people use their company. You can change it whenever you like.
            </p>
            <input
              id="workspace-name"
              className={`${field} mt-3`}
              value={workspace}
              onChange={(e) => setWorkspace(e.target.value)}
              // Empty rather than prefilled: "Personal" is the default every workspace arrives
              // with, not an answer, and a prefilled value is something to delete before you can
              // type. Leaving it blank keeps that default, which is a fine outcome.
              placeholder="Personal"
              maxLength={80}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void advance();
                }
              }}
            />
          </div>
        </section>
      ) : null}

      <section className={step === 2 ? "" : "hidden"}>
        <h1 className="text-3xl font-semibold tracking-tight text-[var(--fg)]">What should we call you</h1>
        <p className="mt-2 text-[15px] leading-6 text-[var(--muted)]">
          This is the name on the documents you share. Not {email ? email : "your sign-in address"},
          unless you want it to be.
        </p>
        <div className="mt-6 flex flex-col gap-2 sm:flex-row">
          <input
            className={field}
            value={first}
            onChange={(e) => setFirst(e.target.value)}
            placeholder="First name"
            aria-label="First name"
            maxLength={60}
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

      <section className={step === 3 ? "" : "hidden"}>
        <h1 className="text-3xl font-semibold tracking-tight text-[var(--fg)]">
          When someone opens what you sent
        </h1>
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

      <section className={step === 3 ? "mt-10" : "hidden"}>
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.1em] text-[var(--muted-2)]">
          When someone finishes reading
        </h2>
        <p className="mt-1.5 text-[13px] leading-5 text-[var(--muted)]">
          The other half: a short brief of the whole visit once the reader has left. Want one email per visit? Keep this and set the one above to never.
        </p>
        <div className="mt-3 grid gap-2">
          {BRIEF_MODES.map((m) => {
            const active = briefMode === m.value;
            return (
              <button
                key={m.value}
                type="button"
                onClick={() => setBriefMode(m.value)}
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

      <section className={step === 4 ? "" : "hidden"}>
        <h1 className="text-3xl font-semibold tracking-tight text-[var(--fg)]">
          What the AI does on its own
        </h1>
        <p className="mt-2 text-[15px] leading-6 text-[var(--muted)]">
          These run without being asked, and each one spends a credit or two. Everything else
          waits for you to click it.
        </p>
        <div className="mt-3 grid gap-2">
          {[
            {
              key: "summary",
              on: autoSummary,
              set: setAutoSummary,
              title: "Summarise every upload",
              body: "A summary and key points written the moment a file lands, so your link says something before anyone opens it.",
            },
            {
              key: "compare",
              on: autoCompare,
              set: setAutoCompare,
              title: "Compare every replacement",
              body: "Replace a document and you get an explanation of what changed since the last version.",
            },
            {
              key: "brief",
              on: autoBrief,
              set: setAutoBrief,
              title: "Brief every visit",
              body: "A few minutes after a reader is done, a short account of what they read, what held them and what they skipped. One credit per visit, on Pro.",
            },
          ].map((run) => (
            <label
              key={run.key}
              className={[
                "flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 transition-colors",
                run.on
                  ? "border-emerald-600/50 bg-emerald-500/5 dark:border-emerald-300/40"
                  : "border-[var(--border)] bg-[var(--panel)] hover:bg-[var(--panel-hover)]",
              ].join(" ")}
            >
              <input
                type="checkbox"
                checked={run.on}
                onChange={(e) => run.set(e.target.checked)}
                className="mt-1 h-4 w-4 shrink-0 accent-emerald-600 dark:accent-emerald-400"
              />
              <span className="min-w-0">
                <span className="block text-[14px] font-medium text-[var(--fg)]">{run.title}</span>
                <span className="mt-1 block text-[13px] leading-5 text-[var(--muted)]">{run.body}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      {problem ? <p className="mt-6 text-[13px] text-[var(--plan-ending-fg)]">{problem}</p> : null}

      <div className="mt-10 flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={() => void advance()}
          disabled={busy}
          className="rounded-lg bg-[var(--fg)] px-4 py-2 text-[14px] font-medium text-[var(--bg)] transition-opacity disabled:opacity-60"
        >
          {busy ? "Saving…" : step < STEP_COUNT ? "Save and continue →" : "Share my first document"}
        </button>
        <button
          type="button"
          onClick={() => void skip()}
          disabled={busy}
          className="text-[13px] text-[var(--muted)] underline-offset-4 transition-colors hover:text-[var(--fg)] hover:underline disabled:opacity-60"
        >
          Skip for now
        </button>
      </div>

      {/* Back is last and quiet: it is for checking an answer, not a route through the flow. It
          re-saves nothing — looking at what you typed should not cost a request. */}
      {step > 1 ? (
        <button
          type="button"
          onClick={() => {
            setProblem(null);
            setStep(step - 1);
          }}
          disabled={busy}
          className="mt-8 text-[13px] text-[var(--muted)] transition-colors hover:text-[var(--fg)] disabled:opacity-60"
        >
          ← Back
        </button>
      ) : null}
      </main>
    </>
  );
}
