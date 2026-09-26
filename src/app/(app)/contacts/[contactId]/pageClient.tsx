/**
 * Client component for `/contacts/:contactId`.
 *
 * Four things, in the order a person asks them: who this is, what we have said about them (the
 * note), how we file them (tags), and what they have done (documents, projects, the ways they
 * arrived). The history rows link down to the reader pages and the projects; nothing here is a
 * copy of a page that already exists.
 *
 * The note is the one editable field. Anyone with the member role can write it; the button fails
 * closed while the plan snapshot loads, so nobody is shown a Save the API will refuse. Saving and
 * clearing both announce themselves in a live region, and clearing asks first, because a note is
 * the one thing here a person wrote and the only copy of it. Identity follows the plan: a redacted
 * contact reads as "Someone at <domain>" and the page says why.
 */
"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeftIcon,
  CheckBadgeIcon,
  DocumentTextIcon,
  FolderIcon,
  UsersIcon,
} from "@heroicons/react/24/outline";

import AppPageHeader, { APP_PAGE_GUTTER } from "@/components/AppPageHeader";
import ContactTags from "@/components/contacts/ContactTags";
import Button from "@/components/ui/Button";
import { useUpgradeModal } from "@/components/UpgradeModalProvider";
import { formatDate, formatRelative } from "@/components/connect/format";
import { usePlan } from "@/lib/client/usePlan";
import { rememberEntityTitles } from "@/lib/client/entityTitles";
import { CONTACT_SOURCE_LABELS, fetchContact, saveContactNote, type ContactDetail } from "@/lib/client/useContacts";

/** The most a note may hold; the API refuses longer. */
const NOTE_MAX = 2000;

/**
 * The look of a button that is unavailable but still focusable.
 *
 * `Button` styles the native `disabled` attribute, which is the wrong tool for a control that
 * becomes unavailable under the person's own cursor: the browser blurs a focused element the
 * moment it is disabled, so saving a note dropped a keyboard user back at the top of the page.
 * These buttons carry `aria-disabled` instead and keep their place in the tab order.
 */
const SOFT_DISABLED = "aria-disabled:cursor-not-allowed aria-disabled:opacity-60";

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-2)]">{children}</h2>;
}

function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={["rounded-2xl border border-[var(--border)] bg-[var(--panel)]", className ?? ""].join(" ")}>{children}</div>;
}

/**
 * One labelled value in the identity card.
 *
 * Values clip by default so the six facts line up. `wrap` is the exception for the address: it is
 * the payload of this card, it is routinely longer than the column, and a clipped address on the
 * one screen whose job is to say who this person is cannot be read anywhere else.
 */
function Fact({ label, wrap, children }: { label: string; wrap?: boolean; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-2)]">{label}</dt>
      <dd className={["mt-0.5 text-sm text-[var(--fg)]", wrap ? "break-words" : "truncate"].join(" ")}>{children}</dd>
    </div>
  );
}

function NoteEditor({
  contact,
  canEdit,
  onSaved,
}: {
  contact: ContactDetail;
  canEdit: boolean;
  onSaved: (next: ContactDetail) => void;
}) {
  const saved = contact.note?.text ?? "";
  const [draft, setDraft] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);

  useEffect(() => {
    setDraft(contact.note?.text ?? "");
  }, [contact.id, contact.note?.text]);

  useEffect(() => {
    setConfirmingClear(false);
  }, [contact.id]);

  const dirty = draft.trim() !== saved;

  async function save(text: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const next = await saveContactNote(contact.id, text);
      setConfirmingClear(false);
      setStatus(text ? "Note saved." : "Note cleared.");
      onSaved(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the note.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-4">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value.slice(0, NOTE_MAX))}
        readOnly={!canEdit}
        rows={4}
        maxLength={NOTE_MAX}
        placeholder={canEdit ? "What the team wants to remember about this person." : "No note yet."}
        aria-label="Note"
        className="w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-sm text-[var(--fg)] outline-none placeholder:text-[var(--muted-2)] focus:ring-2 focus:ring-[var(--ring)] read-only:cursor-default"
      />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-[12px] text-[var(--muted)]">
          {contact.note ? (
            <>
              by {contact.note.byName ?? "a teammate"}, {formatRelative(contact.note.at) || formatDate(contact.note.at)}
            </>
          ) : canEdit ? (
            `${draft.length} / ${NOTE_MAX}`
          ) : null}
        </span>
        {canEdit ? (
          // `aria-disabled`, not the `disabled` attribute: a saved note makes Save unavailable, and
          // a native `disabled` on the element that was just clicked throws keyboard focus back to
          // <body> with nothing said. These stay focusable and announce themselves as unavailable,
          // and `save` refuses the click anyway.
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className={SOFT_DISABLED}
              aria-disabled={busy || !saved}
              onClick={() => {
                if (busy || !saved) return;
                setConfirmingClear((v) => !v);
              }}
            >
              Clear
            </Button>
            <Button
              variant="solid"
              size="sm"
              className={SOFT_DISABLED}
              aria-disabled={busy || !dirty || confirmingClear}
              onClick={() => {
                if (busy || !dirty || confirmingClear) return;
                void save(draft);
              }}
            >
              {busy ? "Saving" : "Save"}
            </Button>
          </div>
        ) : null}
      </div>
      {confirmingClear ? (
        // A note is team knowledge and nothing keeps a copy of it: the server writes `note: null`,
        // the activity row deliberately records only that it was cleared, and the textarea is reset
        // from the response, so there is nothing to undo afterwards. One question first, in place,
        // the way every other destructive action in the app asks it.
        <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2.5">
          <p className="text-[13px] text-[var(--fg)]">
            Clear this note? <span className="text-[var(--muted)]">It cannot be brought back.</span>
          </p>
          <div className="mt-2.5 flex items-center gap-2">
            <Button variant="danger" size="sm" className={SOFT_DISABLED} aria-disabled={busy} onClick={() => { if (!busy) void save(""); }}>
              {busy ? "Clearing" : "Clear"}
            </Button>
            <Button variant="secondary" size="sm" className={SOFT_DISABLED} aria-disabled={busy} onClick={() => { if (!busy) setConfirmingClear(false); }}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      <div role="status" aria-live="polite" className="mt-2 text-[12px] text-[var(--muted)] empty:mt-0">
        {status && !error ? status : ""}
      </div>
      {error ? (
        <div role="alert" className="mt-2 text-[12px] font-medium text-red-600">
          {error}
        </div>
      ) : null}
    </Card>
  );
}

export default function ContactPageClient({ contactId }: { contactId: string }) {
  const [contact, setContact] = useState<ContactDetail | null>(null);
  const [identity, setIdentity] = useState(true);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { plan } = usePlan();
  const { openUpgrade } = useUpgradeModal();
  const canEdit = plan ? plan.canManageLinks : false;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchContact(contactId);
      if (!result) {
        setNotFound(true);
        return;
      }
      setContact(result.contact);
      setIdentity(result.identity);
      setNotFound(false);
      rememberEntityTitles(
        "doc",
        result.contact.docs.map((d) => ({ id: d.docId, title: d.title ?? "" })),
      );
      rememberEntityTitles(
        "project",
        result.contact.projects.map((p) => ({ id: p.projectId, name: p.name ?? "" })),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the contact.");
    } finally {
      setLoading(false);
    }
  }, [contactId]);

  useEffect(() => {
    void load();
  }, [load]);

  const redacted = Boolean(contact && !contact.name && !contact.email);
  const displayName = contact ? contact.name || contact.email || (contact.domain ? `Someone at ${contact.domain}` : "Someone") : "";

  return (
    <div className="flex h-full flex-col">
      <AppPageHeader
        icon={UsersIcon}
        actions={
          <Link
            href="/contacts"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 text-[13px] font-semibold text-[var(--fg)] transition-colors hover:bg-[var(--panel-hover)]"
          >
            <ArrowLeftIcon className="h-4 w-4 text-[var(--muted)]" aria-hidden="true" />
            All contacts
          </Link>
        }
        title={
          contact ? (
            <span className="inline-flex min-w-0 items-center gap-2">
              <span className="truncate">{displayName}</span>
              {contact.verified ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
                  <CheckBadgeIcon className="h-3.5 w-3.5" aria-hidden="true" />
                  Verified
                </span>
              ) : null}
            </span>
          ) : notFound ? (
            <span>Contact not found</span>
          ) : (
            <span className="block h-5 w-40 animate-pulse rounded bg-[var(--panel-hover)]" aria-label="Loading contact" />
          )
        }
        description={
          notFound
            ? "No contact by that id in this workspace. It may belong to another workspace, or the workspace was deleted."
            : contact
              ? [
                  contact.domain ?? null,
                  `first seen ${formatDate(contact.firstSeenAt)}`,
                  `last seen ${formatRelative(contact.lastSeenAt) || formatDate(contact.lastSeenAt)}`,
                ]
                  .filter(Boolean)
                  .join(", ")
              : "One person, across everything this workspace shared with them."
        }
      />

      <div className={`min-h-0 flex-1 overflow-auto bg-[var(--bg)] ${APP_PAGE_GUTTER} py-6`} aria-busy={loading}>
        {error ? (
          <div className="mb-4 rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4 text-sm text-red-700">{error}</div>
        ) : null}

        {contact ? (
          <div className="grid gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <div className="min-w-0">
              <section className="mb-8">
                <SectionTitle>Who</SectionTitle>
                <Card className="p-4">
                  {redacted && !identity ? (
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-[var(--border)] px-3 py-2">
                      <p className="text-[13px] text-[var(--fg)]">Who this is shows on Pro. Free shows people who introduced themselves.</p>
                      <Button variant="solid" size="sm" onClick={() => openUpgrade("analytics_history", { from: "contacts" })}>
                        Upgrade to Pro
                      </Button>
                    </div>
                  ) : null}
                  <dl className="grid gap-4 sm:grid-cols-2">
                    <Fact label="Name">{contact.name ?? <span className="text-[var(--muted)]">Someone</span>}</Fact>
                    <Fact label="Email" wrap>
                      {contact.email ? (
                        <span className="inline-flex flex-wrap items-center gap-1.5">
                          <a href={`mailto:${contact.email}`} title={contact.email} className="break-all hover:underline">
                            {contact.email}
                          </a>
                          {contact.verified ? (
                            <span className="rounded-full border border-[var(--border)] px-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">
                              verified
                            </span>
                          ) : null}
                        </span>
                      ) : (
                        <span className="text-[var(--muted)]">Withheld on Free</span>
                      )}
                    </Fact>
                    <Fact label="Domain">{contact.domain ?? <span className="text-[var(--muted)]">Webmail</span>}</Fact>
                    <Fact label="Arrived">
                      {contact.lastSource ? CONTACT_SOURCE_LABELS[contact.lastSource.kind] : <span className="text-[var(--muted)]">–</span>}
                    </Fact>
                    <Fact label="First seen">
                      <span title={contact.firstSeenAt}>{formatDate(contact.firstSeenAt)}</span>
                    </Fact>
                    <Fact label="Last seen">
                      <span title={contact.lastSeenAt}>
                        {formatRelative(contact.lastSeenAt)} ({formatDate(contact.lastSeenAt)})
                      </span>
                    </Fact>
                  </dl>
                  <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-[12px] text-[var(--muted)]">
                    <span>
                      <span className="font-semibold text-[var(--fg)]">{contact.documentsRead}</span> {contact.documentsRead === 1 ? "document" : "documents"}
                    </span>
                    <span>
                      <span className="font-semibold text-[var(--fg)]">{contact.projectsCount}</span> {contact.projectsCount === 1 ? "project" : "projects"}
                    </span>
                    <span>
                      <span className="font-semibold text-[var(--fg)]">{contact.visits}</span> {contact.visits === 1 ? "visit" : "visits"}
                    </span>
                  </div>
                </Card>
              </section>

              <section className="mb-8">
                <SectionTitle>Documents</SectionTitle>
                {contact.docs.length ? (
                  <Card>
                    <ul className="divide-y divide-[var(--border)]">
                      {contact.docs.map((d) => (
                        <li key={d.docId}>
                          <Link
                            href={`/doc/${encodeURIComponent(d.docId)}/metrics`}
                            className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-[var(--panel-hover)]"
                          >
                            <DocumentTextIcon className="h-4 w-4 shrink-0 text-[var(--muted-2)]" aria-hidden="true" />
                            <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--fg)]">{d.title || "Untitled document"}</span>
                            {d.lastSeenAt ? (
                              <span className="shrink-0 text-xs text-[var(--muted-2)]" title={d.lastSeenAt}>
                                {formatRelative(d.lastSeenAt)}
                              </span>
                            ) : null}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </Card>
                ) : (
                  <p className="text-sm text-[var(--muted)]">No documents yet.</p>
                )}
              </section>

              <section className="mb-8">
                <SectionTitle>Projects</SectionTitle>
                {contact.projects.length ? (
                  <Card>
                    <ul className="divide-y divide-[var(--border)]">
                      {contact.projects.map((p) => (
                        <li key={p.projectId}>
                          <Link
                            href={`/project/${encodeURIComponent(p.slug || p.projectId)}`}
                            className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-[var(--panel-hover)]"
                          >
                            <FolderIcon className="h-4 w-4 shrink-0 text-[var(--muted-2)]" aria-hidden="true" />
                            <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--fg)]">{p.name || "Untitled project"}</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </Card>
                ) : (
                  <p className="text-sm text-[var(--muted)]">No projects yet.</p>
                )}
              </section>

              <section>
                <SectionTitle>How they arrived</SectionTitle>
                {contact.sources.length ? (
                  <Card>
                    <ul className="divide-y divide-[var(--border)]">
                      {contact.sources.map((s, i) => (
                        <li key={`${s.kind}:${s.at}:${i}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                          <span className="font-medium text-[var(--fg)]">{CONTACT_SOURCE_LABELS[s.kind]}</span>
                          {s.docId ? (
                            <Link href={`/doc/${encodeURIComponent(s.docId)}/metrics`} className="text-[12px] text-[var(--muted)] hover:text-[var(--fg)] hover:underline">
                              document
                            </Link>
                          ) : null}
                          {s.projectId ? (
                            <Link href={`/project/${encodeURIComponent(s.projectId)}`} className="text-[12px] text-[var(--muted)] hover:text-[var(--fg)] hover:underline">
                              project
                            </Link>
                          ) : null}
                          {s.shareId ? <span className="text-[12px] text-[var(--muted-2)]">link {s.shareId}</span> : null}
                          <span className="ml-auto text-xs text-[var(--muted-2)]" title={s.at}>
                            {formatRelative(s.at) || formatDate(s.at)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </Card>
                ) : (
                  <p className="text-sm text-[var(--muted)]">Nothing recorded yet.</p>
                )}
              </section>
            </div>

            <div className="min-w-0">
              <section className="mb-8">
                <SectionTitle>Note</SectionTitle>
                <NoteEditor contact={contact} canEdit={canEdit} onSaved={setContact} />
              </section>

              <section>
                <SectionTitle>Tags</SectionTitle>
                <Card className="p-4">
                  <ContactTags contactId={contact.id} initialTags={contact.tags} />
                </Card>
              </section>
            </div>
          </div>
        ) : notFound ? (
          <div className="rounded-2xl border border-dashed border-[var(--border)] p-8 text-center text-sm text-[var(--muted)]">
            <Link href="/contacts" className="font-medium text-[var(--fg)] underline underline-offset-4">
              Back to contacts
            </Link>
          </div>
        ) : null}
      </div>
    </div>
  );
}
