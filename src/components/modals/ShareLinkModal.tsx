/**
 * ShareLinkModal — create or edit one share link of a document (docs/prds/lnkdrp-multi-links.md).
 *
 * The same form serves both modes: create posts to `POST /api/docs/:docId/links`, edit patches
 * `PATCH /api/docs/:docId/links/:linkId` (the caller owns the request; this component only
 * collects values). Only the fields the API accepts are collected: label, audience, enabled,
 * download, revision history, expiry and password.
 *
 * Free workspaces see the `Pro` pill next to the revision-history switch — the switch still
 * toggles (the server decides), the pill opens the upgrade modal. "Copy settings from" (create
 * only) seeds everything but the label and the password from another link of the document.
 */
"use client";

import { useEffect, useMemo, useState } from "react";

import Modal from "@/components/modals/Modal";
import ProPill from "@/components/ProPill";
import type { ShareLinkDTO } from "@/lib/share/links";
import { SHARE_PASSWORD_MIN } from "@/lib/share/passwordPolicy";

/** Values the caller sends to the links API. `password`: `undefined` = leave, `null` = clear. */
export type ShareLinkFormValues = {
  label: string;
  audience: string | null;
  enabled: boolean;
  allowDownload: boolean;
  allowRevisionHistory: boolean;
  /** ISO string, or `null` for "never expires". */
  expiresAt: string | null;
  password?: string | null;
};

type Props = {
  open: boolean;
  /** `create` posts a new link; `edit` patches `link`. */
  mode: "create" | "edit";
  /** The link being edited (ignored in create mode). */
  link?: ShareLinkDTO | null;
  /** Every link of the document — feeds the "Copy settings from" select. */
  links?: ShareLinkDTO[];
  saving?: boolean;
  error?: string | null;
  /** Free workspaces: show the `Pro` pill on the revision-history switch. */
  showProPill?: boolean;
  onProPillClick?: () => void;
  onClose: () => void;
  onSubmit: (values: ShareLinkFormValues) => void;
};



/** `2026-09-13` for a `<input type="date">`, in the viewer's timezone. */
function toDateInputValue(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A date input value becomes end-of-day local time, so "expires Sep 20" includes Sep 20. */
function fromDateInputValue(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  const [y, m, d] = v.split("-").map((n) => Number.parseInt(n, 10));
  if (!y || !m || !d) return null;
  const date = new Date(y, m - 1, d, 23, 59, 59, 999);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString();
}

/** Today in the viewer's timezone, as the `min` of the expiry input. */
function todayInputValue(): string {
  return toDateInputValue(new Date().toISOString());
}

const FIELD_CLASS =
  "mt-1 w-full rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] text-[var(--fg)] placeholder:text-[var(--muted-2)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)] disabled:opacity-60";
const LABEL_CLASS = "text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]";

/** A small labelled switch row, matching the doc share panel's controls. */
function SwitchRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
  trailing,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5 text-[12px] font-medium text-[var(--fg)]">
          <span>{label}</span>
          {trailing}
        </div>
        {hint ? <div className="mt-0.5 text-[12px] text-[var(--muted)]">{hint}</div> : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        className={[
          "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
          checked ? "bg-[var(--primary-bg)]" : "bg-[var(--border)]",
          disabled ? "opacity-50" : "cursor-pointer",
        ].join(" ")}
        onClick={() => onChange(!checked)}
      >
        <span
          aria-hidden="true"
          className={[
            "inline-block h-5 w-5 transform rounded-full bg-[var(--panel)] shadow ring-1 ring-[var(--border)] transition-transform",
            checked ? "translate-x-5" : "translate-x-1",
          ].join(" ")}
        />
      </button>
    </div>
  );
}

/** Create/edit form for one share link. */
export default function ShareLinkModal({
  open,
  mode,
  link = null,
  links = [],
  saving = false,
  error = null,
  showProPill = false,
  onProPillClick,
  onClose,
  onSubmit,
}: Props) {
  const [label, setLabel] = useState("");
  const [audience, setAudience] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [allowDownload, setAllowDownload] = useState(false);
  const [allowRevisionHistory, setAllowRevisionHistory] = useState(false);
  const [expires, setExpires] = useState("");
  const [password, setPassword] = useState("");
  // `keep` leaves the stored password untouched, `set` writes `password`, `clear` removes it.
  const [passwordMode, setPasswordMode] = useState<"keep" | "set" | "clear">("keep");
  const [copyFromId, setCopyFromId] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  // The stored password, once the owner has asked to see it. Never pre-fetched: a reveal is
  // rate-limited and written to the activity feed, so it happens on a click, not on open.
  const [revealed, setRevealed] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Re-seed the form every time the modal opens (or switches to another link).
  useEffect(() => {
    if (!open) return;
    setLocalError(null);
    setCopyFromId("");
    setPassword("");
    setRevealed(null);
    setRevealing(false);
    setRevealError(null);
    setCopied(false);
    if (mode === "edit" && link) {
      setLabel(link.label ?? "");
      setAudience(link.audience ?? "");
      setEnabled(Boolean(link.enabled));
      setAllowDownload(Boolean(link.allowDownload));
      setAllowRevisionHistory(Boolean(link.allowRevisionHistory));
      setExpires(toDateInputValue(link.expiresAt));
      setPasswordMode("keep");
      return;
    }
    setLabel("");
    setAudience("");
    setEnabled(true);
    setAllowDownload(false);
    setAllowRevisionHistory(false);
    setExpires("");
    setPasswordMode("set");
  }, [open, mode, link]);

  const copyOptions = useMemo(() => links.filter((l) => l.id !== link?.id), [links, link?.id]);
  const passwordAlreadySet = mode === "edit" && Boolean(link?.passwordEnabled);

  /** Seed the settings (not the label, never the password) from another link. */
  function copyFrom(id: string) {
    setCopyFromId(id);
    const source = copyOptions.find((l) => l.id === id);
    if (!source) return;
    setAudience(source.audience ?? "");
    setAllowDownload(Boolean(source.allowDownload));
    setAllowRevisionHistory(Boolean(source.allowRevisionHistory));
    const iso = source.expiresAt;
    setExpires(iso && Date.parse(iso) > Date.now() ? toDateInputValue(iso) : "");
  }

  /** Fetch and show the stored password for the link being edited. */
  async function revealPassword() {
    if (!link || revealing) return;
    setRevealing(true);
    setRevealError(null);
    try {
      const res = await fetch(`/api/docs/${encodeURIComponent(link.docId)}/links/${encodeURIComponent(link.id)}/password`, { cache: "no-store" });
      const body = (await res.json().catch(() => ({}))) as { password?: unknown; error?: unknown };
      if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : "Could not show the password.");
      if (typeof body.password === "string" && body.password) setRevealed(body.password);
      else setRevealError("This password cannot be shown. Use Change to set a new one.");
    } catch (err) {
      setRevealError(err instanceof Error ? err.message : "Could not show the password.");
    } finally {
      setRevealing(false);
    }
  }

  /** Copy the revealed password, with a brief confirmation on the button. */
  async function copyRevealed() {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setRevealError("Could not copy. Select the password and copy it manually.");
    }
  }

  /** Validate the form and hand the values to the caller. */
  function submit() {
    if (saving) return;
    const trimmedLabel = label.trim();
    if (!trimmedLabel) {
      setLocalError("Give the link a label, for example “Sequoia · Roelof”.");
      return;
    }
    const pwd = password.trim();
    if (passwordMode === "set" && pwd && pwd.length < SHARE_PASSWORD_MIN) {
      setLocalError("The password cannot be blank.");
      return;
    }
    setLocalError(null);
    onSubmit({
      label: trimmedLabel,
      audience: audience.trim() ? audience.trim() : null,
      enabled,
      allowDownload,
      allowRevisionHistory,
      expiresAt: fromDateInputValue(expires),
      password: passwordMode === "clear" ? null : passwordMode === "set" && pwd ? pwd : undefined,
    });
  }

  const shownError = localError ?? error;

  return (
    <Modal
      open={open}
      onClose={() => {
        if (saving) return;
        onClose();
      }}
      ariaLabel={mode === "create" ? "New share link" : "Edit share link"}
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="text-base font-semibold text-[var(--fg)]">
            {mode === "create" ? "New link" : "Edit link"}
          </div>
          {saving ? <div className="text-xs font-medium text-[var(--muted-2)]">Saving…</div> : null}
        </div>

        <div className="text-sm text-[var(--muted)]">
          Every link has its own settings and its own stats. Labels are private to you — recipients
          never see them.
        </div>

        {mode === "create" && copyOptions.length ? (
          <div>
            <div className={LABEL_CLASS}>Copy settings from</div>
            <select
              value={copyFromId}
              onChange={(e) => copyFrom(e.currentTarget.value)}
              disabled={saving}
              className={FIELD_CLASS}
              aria-label="Copy settings from another link"
            >
              <option value="">Start from defaults</option>
              {copyOptions.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <div>
          <label className={LABEL_CLASS} htmlFor="share-link-label">
            Label
          </label>
          <input
            id="share-link-label"
            value={label}
            onChange={(e) => setLabel(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              submit();
            }}
            disabled={saving || Boolean(link?.isDefault)}
            placeholder="e.g. Sequoia"
            maxLength={80}
            autoFocus
            className={FIELD_CLASS}
          />
          {link?.isDefault ? (
            <div className="mt-1 text-[11px] text-[var(--muted-2)]">
              The default link keeps its name.
            </div>
          ) : null}
        </div>

        <div>
          <label className={LABEL_CLASS} htmlFor="share-link-audience">
            Audience (optional)
          </label>
          <input
            id="share-link-audience"
            value={audience}
            onChange={(e) => setAudience(e.currentTarget.value)}
            disabled={saving}
            placeholder="e.g. Roelof · Series A"
            maxLength={120}
            className={FIELD_CLASS}
          />
        </div>

        <div className="grid gap-2">
          <SwitchRow
            label="Link enabled"
            hint={enabled ? "Anyone with this link can view the document." : "Recipients see “This document is no longer shared.”"}
            checked={enabled}
            disabled={saving}
            onChange={setEnabled}
          />
          <SwitchRow label="Allow download" checked={allowDownload} disabled={saving} onChange={setAllowDownload} />
          <SwitchRow
            label="Let recipients browse versions"
            hint="They see each version with its date and what changed. Owner-side version history and AI compare are separate."
            checked={allowRevisionHistory}
            disabled={saving}
            onChange={setAllowRevisionHistory}
            trailing={showProPill ? <ProPill onClick={onProPillClick} /> : null}
          />
        </div>

        <div>
          <label className={LABEL_CLASS} htmlFor="share-link-expires">
            Expires (optional)
          </label>
          <div className="mt-1 flex items-center gap-2">
            <input
              id="share-link-expires"
              type="date"
              value={expires}
              min={todayInputValue()}
              onChange={(e) => setExpires(e.currentTarget.value)}
              disabled={saving}
              className="h-9 min-w-0 flex-1 rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 text-[13px] text-[var(--fg)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)] disabled:opacity-60"
            />
            {expires ? (
              <button
                type="button"
                onClick={() => setExpires("")}
                disabled={saving}
                className="shrink-0 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[12px] font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)] disabled:opacity-50"
              >
                Clear
              </button>
            ) : null}
          </div>
          <div className="mt-1 text-[11px] text-[var(--muted-2)]">
            {expires ? "The link stops working at the end of that day." : "Never expires."}
          </div>
        </div>

        <div>
          <div className={LABEL_CLASS}>Password (optional)</div>
          {passwordAlreadySet && passwordMode === "keep" ? (
            <div className="mt-1 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
              {revealed ? (
                <span className="break-all font-mono text-[12px] text-[var(--fg)]" aria-label="Share link password">
                  {revealed}
                </span>
              ) : (
                <span className="text-[12px] text-[var(--fg)]">Password protected</span>
              )}
              <span className="flex-1" />
              {revealed ? (
                <button type="button" onClick={() => void copyRevealed()} className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-[12px] font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)] disabled:opacity-50">
                  {copied ? "Copied" : "Copy"}
                </button>
              ) : (
                <button type="button" onClick={() => void revealPassword()} disabled={saving || revealing} className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-[12px] font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)] disabled:opacity-50">
                  {revealing ? "Showing…" : "Show"}
                </button>
              )}
              <button
                type="button"
                onClick={() => setPasswordMode("set")}
                disabled={saving}
                className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-[12px] font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)] disabled:opacity-50"
              >
                Change
              </button>
              <button
                type="button"
                onClick={() => setPasswordMode("clear")}
                disabled={saving}
                className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-[12px] font-semibold text-red-600 hover:bg-[var(--panel-hover)] disabled:opacity-50 dark:text-red-300"
              >
                Remove
              </button>
              </div>
              {revealError ? <div className="mt-1 text-[11px] text-red-600 dark:text-red-300">{revealError}</div> : null}
            </div>
          ) : passwordMode === "clear" ? (
            <div className="mt-1 flex flex-wrap items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2">
              <span className="text-[12px] text-[var(--muted)]">The password will be removed when you save.</span>
              <span className="flex-1" />
              <button
                type="button"
                onClick={() => setPasswordMode("keep")}
                disabled={saving}
                className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-[12px] font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)] disabled:opacity-50"
              >
                Undo
              </button>
            </div>
          ) : (
            <>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.currentTarget.value)}
                disabled={saving}
                placeholder="Any password you like"
                autoComplete="new-password"
                className={FIELD_CLASS}
                aria-label="Share link password"
              />
              <div className="mt-1 flex items-center gap-2 text-[11px] text-[var(--muted-2)]">
                <span>Leave empty for no password.</span>
                {passwordAlreadySet ? (
                  <button
                    type="button"
                    onClick={() => {
                      setPassword("");
                      setPasswordMode("keep");
                    }}
                    disabled={saving}
                    className="font-medium text-[var(--fg)] underline-offset-2 hover:underline disabled:opacity-50"
                  >
                    Keep the current password
                  </button>
                ) : null}
              </div>
            </>
          )}
        </div>

        {shownError ? <div className="text-sm font-medium text-red-700">{shownError}</div> : null}

        <div className="flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-4 py-2 text-sm font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving}
            className="inline-flex items-center justify-center rounded-lg bg-[var(--primary-bg)] px-4 py-2 text-sm font-semibold text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)] disabled:opacity-50"
          >
            {saving ? "Saving…" : mode === "create" ? "Create link" : "Save changes"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
