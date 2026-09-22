/**
 * Everything else we send, and why none of it has a switch.
 *
 * The Notifications page was two dropdowns, which described two of the dozen emails this product
 * sends. That is not a settings page, it is a fragment of one — and the missing part is exactly
 * what somebody goes looking for when an email arrives they did not expect.
 *
 * So the rest are listed rather than made configurable. Each says what causes it and, where there
 * is no setting, why there is none. Most are transactional: one email, one action, and a switch
 * that suppressed "you were removed" or "new documents are paused" would leave somebody blocked
 * with no idea why.
 *
 * Read from `EMAIL_CATALOG`, so an email added to the product appears here without anyone
 * remembering to add it.
 */
"use client";

import { EMAIL_CATALOG } from "@/lib/email/templates";
import { EMAIL_COPY, type EmailAudience } from "@/lib/email/catalogCopy";

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
  return (
    <div className="grid gap-6">
      <Group
        title="Always sent to you"
        caption="Each of these is one email, caused by one thing happening. There is no setting because there is nothing recurring to turn down."
        audience="you"
      />
      <Group
        title="Sent to people you share with"
        caption="These go to readers and people you invite, not to you. They are part of how sharing works rather than notifications about it."
        audience="others"
      />
    </div>
  );
}
