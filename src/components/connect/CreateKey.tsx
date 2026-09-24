"use client";

import { useState } from "react";

import { refreshAgentStatus, type AgentKeyRow } from "@/lib/client/useAgentStatus";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";

/**
 * Creating a key, and showing it once.
 *
 * Shared by the Connect page's "Create a key" step (the key path) and the Keys and agents panel's
 * "Create key" action, so there is one form and one reveal, wherever the person started from.
 */

export const DEFAULT_KEY_NAME = "Claude Code on my laptop";
export const MAX_ACTIVE_KEYS = 10;

export const PRIMARY_BUTTON =
  "inline-flex h-9 items-center justify-center rounded-xl bg-[var(--primary-bg)] px-4 text-[13px] font-semibold text-[var(--primary-fg)] shadow-[0_1px_2px_var(--primary-shadow)] transition-colors hover:bg-[var(--primary-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary-ring)] disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none";
export const QUIET_BUTTON =
  "inline-flex h-9 items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3.5 text-[13px] font-medium text-[var(--muted)] transition-colors hover:bg-[var(--panel-hover)] hover:text-[var(--fg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none";

export type CreatedKey = { plaintext: string; key: AgentKeyRow };

/** Map a create/revoke failure to the sentence shown inline. */
export function errorMessage(status: number, body: { error?: unknown } | null, fallback: string): string {
  if (status === 403) return "Only workspace owners and admins can manage keys.";
  if (status === 409 && body?.error === "key_limit")
    return `This workspace already has ${MAX_ACTIVE_KEYS} active keys. Revoke one to create another.`;
  if (typeof body?.error === "string" && body.error) return body.error;
  return fallback;
}

/** The one moment on the page that should stand out: the plaintext key, shown once. */
export function RevealBox({ created, onDismiss }: { created: CreatedKey; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(created.plaintext);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard unavailable; the key is selectable.
    }
  };
  return (
    <div className="rounded-xl border border-[var(--fg)]/30 bg-[var(--panel-2)] p-4 motion-safe:animate-[lnkdrpUpgradeIn_180ms_ease-out]" role="region" aria-label="Your new key">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="text-[13px] font-semibold text-[var(--fg)]">{created.key.name}</div>
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--muted-2)]">Shown once</div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 select-all break-all rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 font-mono text-[13px] text-[var(--fg)]">
          {created.plaintext}
        </code>
        <button type="button" onClick={() => void copy()} className={PRIMARY_BUTTON} aria-live="polite">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="mt-3 text-[13px] leading-5 text-[var(--muted)]">
        Shown once. After you leave this page only the prefix is kept.
      </p>
      {/* The next step, made unmissable: the client commands below are already filled with this key. */}
      <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2.5 text-[13px] leading-5 text-[var(--fg)]">
        <span className="font-semibold">Next:</span> go to step 2 below and add lnkdrp to your client. The commands there already include this key.
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="mt-3 text-[12px] font-medium text-[var(--muted-2)] underline-offset-4 hover:text-[var(--fg)] hover:underline"
      >
        I have stored it
      </button>
    </div>
  );
}

/** Name it, create it. Calls `onCreated` with the plaintext (shown once) and refreshes the shared status. */
export function CreateKeyForm({
  onCreated,
  onCancel,
  className,
}: {
  onCreated: (plaintext: string, key: AgentKeyRow) => void;
  /** When set, a Cancel button closes the form. */
  onCancel?: () => void;
  className?: string;
}) {
  const [name, setName] = useState(DEFAULT_KEY_NAME);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Give the key a name.");
      return;
    }
    if (trimmed.length > 60) {
      setError("Keep the name under 60 characters.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetchWithTempUser("/api/agent/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      const body = (await res.json().catch(() => null)) as { key?: AgentKeyRow; plaintext?: string; error?: unknown } | null;
      if (res.status !== 201 || !body?.plaintext || !body.key) {
        setError(errorMessage(res.status, body, "Could not create the key."));
        return;
      }
      onCreated(body.plaintext, body.key);
      setName(DEFAULT_KEY_NAME);
      refreshAgentStatus();
    } catch {
      setError("Could not create the key.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      className={["rounded-xl border border-[var(--border)] bg-[var(--panel-2)] p-4", className ?? ""].join(" ")}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor="key-name" className="block text-[12px] font-medium text-[var(--muted)]">
        Name this key after the agent or machine that will use it
      </label>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          id="key-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={60}
          autoFocus
          autoComplete="off"
          className="h-9 min-w-0 flex-1 rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 text-[13px] text-[var(--fg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
        />
        <button type="submit" disabled={submitting} className={PRIMARY_BUTTON}>
          {submitting ? "Creating…" : "Create"}
        </button>
        {onCancel ? (
          <button type="button" onClick={onCancel} disabled={submitting} className={QUIET_BUTTON}>
            Cancel
          </button>
        ) : null}
      </div>
      {error ? (
        <div role="alert" className="mt-2 text-[12px] text-red-600 dark:text-red-400">
          {error}
        </div>
      ) : null}
    </form>
  );
}
