/**
 * Everything else we send, behind one line of text.
 *
 * The Notifications page was two dropdowns, which described two of the dozen emails this product
 * sends — a fragment claiming to be a settings page, missing exactly the part somebody goes
 * looking for when an unexpected email turns up.
 *
 * The rest are listed rather than made configurable. Most are transactional: one email, one
 * action, and a switch suppressing "you were removed" or "new documents are paused" would leave
 * somebody locked out with no idea why. So each says what causes it and why it has no setting.
 *
 * In a modal rather than on the page, because ten cards under two dropdowns gives the most weight
 * to the things you cannot change, and the settings are what the page is for. This answers a
 * question people ask once — usually right after an email they did not expect — so it needs to be
 * one click away, not permanently open. The trigger says how many, so it reads as an answer
 * waiting rather than a link to nowhere.
 *
 * Read from `EMAIL_CATALOG`, so an email added to the product appears here on its own.
 */
"use client";

// From the data module, never the template barrel: the barrel drags mongoose models
// into the browser and this component is client-side.
import { useState } from "react";

import { EMAIL_CATALOG } from "@/lib/email/catalog";
import { EMAIL_COPY, type EmailAudience } from "@/lib/email/catalogCopy";
import Modal from "@/components/modals/Modal";

/** Rows with a preference are already represented by the controls above; these are the others. */
function rowsFor(audience: EmailAudience) {
  return EMAIL_CATALOG.map((entry) => ({ id: entry.id, copy: EMAIL_COPY[entry.id] }))
    .filter((r) => r.copy && !r.copy.setting && !r.copy.flagged && r.copy.audience === audience)
    .map((r) => ({ id: r.id, ...r.copy! }));
}

function Group({
  title,
  caption,
  audience,
}: {
  title: string;
  caption: string;
  audience: EmailAudience;
}) {
  const rows = rowsFor(audience);
  if (!rows.length) return null;

  return (
    <div>
      <div className="text-[13px] font-semibold text-[var(--fg)]">{title}</div>
      <div className="mt-0.5 text-[12px] text-[var(--muted-2)]">{caption}</div>

      <ul className="mt-3 grid gap-2">
        {rows.map((row) => (
          <li
            key={row.id}
            className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-3"
          >
            <div className="text-[13px] font-medium text-[var(--fg)]">{row.label}</div>
            <div className="mt-0.5 text-[12px] leading-5 text-[var(--muted)]">{row.when}</div>
            {row.why ? (
              <div className="mt-1 text-[12px] leading-5 text-[var(--muted-2)]">{row.why}</div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function EmailCatalogList() {
  const [open, setOpen] = useState(false);
  const count = rowsFor("you").length + rowsFor("others").length;
  if (!count) return null;

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-[var(--fg)]">
          We send {count} other emails, and none of them repeat
        </div>
        <div className="mt-0.5 text-[12px] text-[var(--muted-2)]">
          Each one is a single message caused by a single thing happening, so there is nothing to turn down.
        </div>
      </div>

      <button
        type="button"
        onClick={() => setOpen(true)}
        className="shrink-0 rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-[13px] font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)]"
      >
        See the list
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        ariaLabel="Every email LinkDrop sends"
        panelClassName="w-[min(620px,calc(100vw-32px))]"
      >
        <div className="text-base font-semibold text-[var(--fg)]">Every other email we send</div>
        <p className="mt-1 text-[13px] leading-6 text-[var(--muted)]">
          The ones above repeat, so they have settings. These do not: each is one message, caused by one thing, and
          turning it off would mean something happening to your account without you being told.
        </p>

        <div className="mt-5 grid gap-6">
          <Group
            title="Sent to you"
            caption="In your inbox, when the thing described happens."
            audience="you"
          />
          <Group
            title="Sent to people you share with"
            caption="These reach readers and people you invite, not you. They are part of how sharing works rather than notifications about it."
            audience="others"
          />
        </div>
      </Modal>
    </div>
  );
}
