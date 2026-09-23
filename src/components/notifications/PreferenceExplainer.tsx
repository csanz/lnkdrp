/**
 * The "?" beside an email preference, and what it opens.
 *
 * A dropdown reading Off / Daily digest / Immediately answers "how often" and none of the
 * questions people actually have: what sets this off, when exactly a digest arrives, what is
 * inside it, and whether turning it off loses anything. Those were only answerable by receiving
 * one, which is a poor way to find out.
 *
 * Follows `ReadingLegendButton` (components/metrics/DepthBadge.tsx): a real target with room
 * around it, never a 10px hotspot inside a row that is itself interactive.
 */
"use client";

import { useState } from "react";

import Modal from "@/components/modals/Modal";

type Explainer = {
  title: string;
  /** One sentence on what causes the email at all. */
  trigger: string;
  /** What each dropdown value actually does, in the order they appear. */
  options: Array<{ label: string; what: string }>;
  /** What the email contains once it arrives. */
  contains: string[];
  /** The caveat worth knowing before choosing. */
  note?: string;
};

const EXPLAINERS: Record<string, Explainer> = {
  views: {
    title: "When someone opens a link",
    trigger:
      "A recipient opens one of this workspace's share links. Your own opens never count, and a reader returning to a document they already opened is reported separately from a new one.",
    options: [
      { label: "Off", what: "Nothing is sent. The opens are still recorded, so the metrics pages are unaffected." },
      {
        label: "Daily digest",
        what: "One email at the end of the UTC day, covering every reader since the last one. Nothing arrives on a day with no opens.",
      },
      {
        label: "Immediately",
        what: "Within about five minutes of the open, one email per document. A burst of readers on one document is still one email.",
      },
    ],
    contains: [
      "Which link they used, and the audience it was made for",
      "How far they read — pages reached and time spent",
      "A link straight to that reader's activity",
    ],
    note:
      "Who the reader is can only be shown on Pro. On Free the email says which link was opened and when, without naming anyone.",
  },
  briefs: {
    title: "When someone finishes reading",
    trigger:
      "A recipient stops reading one of this workspace's links and stays away for a couple of minutes. The visit is then written up by the AI: what held them, what they skipped, how it compares with their last visit. One credit per brief, on Pro, and only while automatic briefs are on under AI defaults.",
    options: [
      { label: "Off", what: "Nothing is sent. The brief is still written and stored on the reader's page." },
      {
        label: "Daily digest",
        what: "One email at the end of the UTC day with every visit since the last one and its brief.",
      },
      {
        label: "After each visit",
        what: "Within about five minutes of the reader leaving. One email per visit, with the brief's headline as the subject.",
      },
    ],
    contains: [
      "Who read it, through which link, and for how long",
      "The AI brief: a paragraph and a few facts about the visit",
      "The pages that held them longest, and the ones they skipped",
      "A link straight to that reader's activity",
    ],
    note:
      "A glance — under twenty seconds on one page — is not written up and sends nothing immediately; it shows in the digest. When credits run out you still get the facts of the visit, without the write-up. Most people keep either this or the link-open email, not both.",
  },
  docUploads: {
    title: "When a teammate adds a document",
    trigger:
      "Someone else in this workspace uploads a new document. Your own uploads never send you anything — you were there.",
    options: [
      { label: "Off", what: "Nothing is sent. The document still appears in the workspace and in the activity feed." },
      {
        label: "Daily digest",
        what: "One email at the end of the UTC day listing everything your teammates added since the last one.",
      },
      { label: "Immediately", what: "Within about five minutes of the upload finishing." },
    ],
    contains: ["Who added it", "The document's name and how many pages it has", "A link straight to it"],
    note:
      "A personal workspace never sends these: it has one member, and that member is always the person who uploaded.",
  },
  docUpdates: {
    title: "Doc update emails",
    trigger:
      "Someone replaces a document with a new version and the comparison finds actual changes. A re-upload that changes nothing sends nothing.",
    options: [
      { label: "Off", what: "Nothing is sent. Version history still records every replacement." },
      { label: "Daily digest", what: "One email at the end of the UTC day listing every document replaced since the last one." },
      { label: "Immediately", what: "Within about five minutes of the replacement." },
    ],
    contains: [
      "Which document was replaced, and its new version number",
      "A summary of what changed between the two versions",
    ],
    note: "This is about documents changing, not about people reading them — those are the link-open emails above.",
  },
};

export default function PreferenceExplainer({ topic }: { topic: keyof typeof EXPLAINERS | string }) {
  const [open, setOpen] = useState(false);
  const info = EXPLAINERS[topic];
  if (!info) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`About: ${info.title}`}
        title={`About: ${info.title}`}
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[var(--border)] text-[10px] font-semibold text-[var(--muted-2)] transition-colors hover:border-[var(--muted-2)] hover:text-[var(--fg)]"
      >
        ?
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        ariaLabel={info.title}
        panelClassName="w-[min(560px,calc(100vw-32px))]"
      >
        <div className="text-base font-semibold text-[var(--fg)]">{info.title}</div>
        <p className="mt-1 text-[13px] leading-6 text-[var(--muted)]">{info.trigger}</p>

        <div className="mt-4 grid gap-2">
          {info.options.map((o) => (
            <div
              key={o.label}
              className="flex gap-3 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-3"
            >
              <span className="w-[92px] shrink-0 pt-px text-[13px] font-semibold text-[var(--fg)]">{o.label}</span>
              <span className="min-w-0 text-[13px] leading-6 text-[var(--muted)]">{o.what}</span>
            </div>
          ))}
        </div>

        <div className="mt-4">
          <div className="text-[13px] font-semibold text-[var(--fg)]">What the email contains</div>
          <ul className="mt-1.5 grid gap-1">
            {info.contains.map((c) => (
              <li key={c} className="flex gap-2 text-[13px] leading-6 text-[var(--muted)]">
                <span aria-hidden="true" className="text-[var(--muted-2)]">
                  &middot;
                </span>
                <span className="min-w-0">{c}</span>
              </li>
            ))}
          </ul>
        </div>

        {info.note ? <p className="mt-4 text-[12px] leading-5 text-[var(--muted-2)]">{info.note}</p> : null}

        <p className="mt-4 text-[12px] leading-5 text-[var(--muted-2)]">
          These settings apply to this workspace only. A workspace can be an entirely different company, so each one is
          set separately.
        </p>
      </Modal>
    </>
  );
}
