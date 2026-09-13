"use client";

import { useState } from "react";

import { refreshAgentStatus, type AgentKeyRow, type AgentStatus } from "@/lib/client/useAgentStatus";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import Modal from "@/components/modals/Modal";
import Panel from "./Panel";
import { formatDate, formatRelative } from "./format";

const DEFAULT_KEY_NAME = "Claude Code on my laptop";
const MAX_ACTIVE_KEYS = 10;

const PRIMARY_BUTTON =
  "inline-flex h-9 items-center justify-center rounded-xl bg-[var(--primary-bg)] px-4 text-[13px] font-semibold text-[var(--primary-fg)] shadow-[0_1px_2px_var(--primary-shadow)] transition-colors hover:bg-[var(--primary-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary-ring)] disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none";
const QUIET_BUTTON =
  "inline-flex h-9 items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3.5 text-[13px] font-medium text-[var(--muted)] transition-colors hover:bg-[var(--panel-hover)] hover:text-[var(--fg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none";

type CreatedKey = { plaintext: string; key: AgentKeyRow };

/** Map a create/revoke failure to the sentence shown inline. */
function errorMessage(status: number, body: { error?: unknown } | null, fallback: string): string {
  if (status === 403) return "Only workspace owners and admins can manage keys.";
  if (status === 409 && body?.error === "key_limit")
    return `This workspace already has ${MAX_ACTIVE_KEYS} active keys. Revoke one to create another.`;
  if (typeof body?.error === "string" && body.error) return body.error;
  return fallback;
}

/** The one moment on the page that should stand out: the plaintext key, shown once. */
function RevealBox({ created, onDismiss }: { created: CreatedKey; onDismiss: () => void }) {
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

/** One key in the list: name, prefix, dates, and a two-step Revoke for managers. */
/** Owner display name for shared workspaces: name, else the email's local part. */
function ownerName(owner: AgentKeyRow["createdBy"]): string | null {
  if (!owner) return null;
  if (owner.name && owner.name.trim()) return owner.name.trim();
  if (owner.email) return owner.email.split("@")[0] || owner.email;
  return null;
}

function KeyRow({
  row,
  canManage,
  showOwner,
  inUse = false,
  onUse,
  onRevoked,
}: {
  row: AgentKeyRow;
  canManage: boolean;
  /** Shared workspaces: show whose key it is so a team can see each other's agents. */
  showOwner: boolean;
  /** True when the commands in steps 2 and 3 are currently filled with this key. */
  inUse?: boolean;
  /**
   * "Use in commands": the server only keeps a hash, so after a reload the page cannot recover the
   * plaintext. The member pastes the key they saved; it is checked against this row's prefix and
   * length and kept in memory only, never sent anywhere.
   */
  onUse?: (plaintext: string) => void;
  onRevoked: (id: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasted, setPasted] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const submitPaste = () => {
    const v = pasted.trim();
    if (!v.startsWith(row.prefix) || v.length !== 36) {
      setPasteError(`That is not this key. It starts with ${row.prefix} and is 36 characters.`);
      return;
    }
    onUse?.(v);
    setPasteOpen(false);
    setPasted("");
    setPasteError(null);
  };
  const [error, setError] = useState<string | null>(null);

  const revoke = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetchWithTempUser(`/api/agent/keys/${encodeURIComponent(row.id)}`, { method: "DELETE" });
      if (res.status !== 204 && !res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
        setError(errorMessage(res.status, body, "Could not revoke the key."));
        return;
      }
      onRevoked(row.id);
      refreshAgentStatus();
    } catch {
      setError("Could not revoke the key.");
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  const lastUsed = row.lastUsedAt
    ? [formatRelative(row.lastUsedAt), row.lastUsedClient].filter(Boolean).join(" · ")
    : "Never used";
  const owner = showOwner ? ownerName(row.createdBy) : null;

  return (
    <li className={["flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3", row.revoked ? "opacity-60" : ""].join(" ")}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px]">
          <span className="font-medium text-[var(--fg)]">{row.name}</span>
          <code className="font-mono text-[12px] text-[var(--muted-2)]">{row.prefix}…</code>
          {row.revoked ? (
            <span className="rounded-md px-1.5 py-px text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--muted-2)] ring-1 ring-[var(--border)]">
              Revoked
            </span>
          ) : inUse ? (
            <span className="rounded-md bg-[var(--panel-hover)] px-1.5 py-px text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--fg)] ring-1 ring-[var(--border)]">
              In steps 2 and 3
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 text-[11px] text-[var(--muted-2)]">
          Created {formatDate(row.createdAt)}
          {owner ? (
            <>
              <span aria-hidden="true"> · </span>
              by <span className="text-[var(--muted)]">{owner}</span>
            </>
          ) : null}
          <span aria-hidden="true"> · </span>
          {row.revoked ? (row.lastUsedAt ? `Revoked · last used ${lastUsed}` : "Revoked · never used") : lastUsed}
        </div>
        {error ? (
          <div role="alert" className="mt-1 text-[12px] text-red-600 dark:text-red-400">
            {error}
          </div>
        ) : null}
      </div>
      {!row.revoked && onUse && !inUse ? (
        pasteOpen ? (
          <form
            className="flex basis-full flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              submitPaste();
            }}
          >
            <input
              type="text"
              autoFocus
              value={pasted}
              onChange={(e) => {
                setPasted(e.target.value);
                setPasteError(null);
              }}
              placeholder={`${row.prefix}…`}
              spellCheck={false}
              autoComplete="off"
              aria-label="Paste the full key"
              className="h-9 w-72 max-w-full rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 font-mono text-[12px] text-[var(--fg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            />
            <button type="submit" className={PRIMARY_BUTTON}>Use</button>
            <button type="button" onClick={() => { setPasteOpen(false); setPasted(""); setPasteError(null); }} className={QUIET_BUTTON}>
              Cancel
            </button>
            {pasteError ? (
              <div role="alert" className="basis-full text-[12px] text-red-600 dark:text-red-400">
                {pasteError}
              </div>
            ) : null}
          </form>
        ) : (
          <button type="button" onClick={() => setPasteOpen(true)} className={QUIET_BUTTON} title="Paste the key you saved to fill the commands in steps 2 and 3">
            Use in commands
          </button>
        )
      ) : null}
      {canManage && !row.revoked ? (
        confirming ? (
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-[var(--muted)]">Revoke this key?</span>
            <button type="button" onClick={() => void revoke()} disabled={busy} className={PRIMARY_BUTTON}>
              {busy ? "Revoking…" : "Revoke"}
            </button>
            <button type="button" onClick={() => setConfirming(false)} disabled={busy} className={QUIET_BUTTON}>
              Cancel
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setConfirming(true)} className={QUIET_BUTTON}>
            Revoke
          </button>
        )
      ) : null}
    </li>
  );
}

/**
 * Keys panel on the Connect page: list of API keys (name, prefix, created, last used and client),
 * revoke for owners and admins, and an inline create form whose 201 result reveals the plaintext
 * once. Calls `refreshAgentStatus()` after every mutation; the parent gets the plaintext through
 * `onCreated` so the client tabs and verify block can use it.
 */
export default function KeysPanel({
  status,
  loading,
  plaintextKey = null,
  onCreated,
  onUse,
  onRevoked,
}: {
  status: AgentStatus | null;
  loading: boolean;
  /** The key currently filled into steps 2 and 3 (created this visit or pasted back), if any. */
  plaintextKey?: string | null;
  onCreated: (plaintext: string, key: AgentKeyRow) => void;
  /** A member pasted a saved key back to fill the commands (memory only). */
  onUse?: (plaintext: string) => void;
  onRevoked: (id: string) => void;
}) {
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState(DEFAULT_KEY_NAME);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedKey | null>(null);

  const canManage = Boolean(status?.canManage);
  const keys = status?.keys ?? [];
  // Active keys stay in the panel; revoked ones move behind a link so step 2 is never pushed down
  // by history. The modal keeps the full audit trail one click away.
  const activeKeys = keys.filter((k) => !k.revoked);
  const revokedKeys = keys.filter((k) => k.revoked);
  const [revokedOpen, setRevokedOpen] = useState(false);
  const activeCount = keys.filter((k) => !k.revoked).length;

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
      const next = { plaintext: body.plaintext, key: body.key };
      setCreated(next);
      onCreated(next.plaintext, next.key);
      setFormOpen(false);
      setName(DEFAULT_KEY_NAME);
      refreshAgentStatus();
    } catch {
      setError("Could not create the key.");
    } finally {
      setSubmitting(false);
    }
  };

  const action =
    canManage && !formOpen ? (
      <button type="button" onClick={() => { setFormOpen(true); setError(null); }} className={PRIMARY_BUTTON}>
        Create key
      </button>
    ) : null;

  return (
    <Panel id="keys" step={1} title="Create a key" caption={status ? `${activeCount} active` : undefined} action={action}>
      {created ? (
        <div className="mb-4">
          <RevealBox
            created={created}
            onDismiss={() => setCreated(null)}
          />
        </div>
      ) : null}

      {formOpen ? (
        <form
          className="mb-4 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] p-4"
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
            <button type="button" onClick={() => { setFormOpen(false); setError(null); }} disabled={submitting} className={QUIET_BUTTON}>
              Cancel
            </button>
          </div>
          {error ? (
            <div role="alert" className="mt-2 text-[12px] text-red-600 dark:text-red-400">
              {error}
            </div>
          ) : null}
        </form>
      ) : error ? (
        <div role="alert" className="mb-4 text-[12px] text-red-600 dark:text-red-400">
          {error}
        </div>
      ) : null}

      {!status && loading ? (
        <ul className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)]" aria-hidden="true">
          {Array.from({ length: 2 }).map((_, i) => (
            <li key={i} className="px-4 py-3 motion-safe:animate-pulse" style={{ animationDelay: `${i * 80}ms` }}>
              <div className="h-3.5 w-[min(320px,60%)] rounded bg-[var(--panel-hover)]" />
              <div className="mt-2 h-3 w-40 rounded bg-[var(--panel-hover)]" />
            </li>
          ))}
        </ul>
      ) : !status ? (
        <p className="text-[13px] text-[var(--muted)]">Could not load the keys for this workspace. Reload to try again.</p>
      ) : activeKeys.length === 0 ? (
        <p className="text-[13px] leading-5 text-[var(--muted)]">
          {canManage
            ? "No active keys. Create one per agent or machine, so you can revoke a single one later."
            : "No active keys. Ask a workspace owner to create a key."}
        </p>
      ) : (
        <ul className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)]">
          {activeKeys.map((row) => (
            <KeyRow
              key={row.id}
              row={row}
              canManage={canManage}
              showOwner={!status?.isPersonalOrg}
              inUse={Boolean(plaintextKey && plaintextKey.startsWith(row.prefix))}
              onUse={onUse}
              onRevoked={onRevoked}
            />
          ))}
        </ul>
      )}

      {revokedKeys.length > 0 ? (
        <div className="mt-3 text-[12px] text-[var(--muted-2)]">
          <button
            type="button"
            onClick={() => setRevokedOpen(true)}
            className="font-medium underline-offset-4 hover:text-[var(--fg)] hover:underline"
          >
            {revokedKeys.length} revoked {revokedKeys.length === 1 ? "key" : "keys"}
          </button>
        </div>
      ) : null}

      <Modal open={revokedOpen} onClose={() => setRevokedOpen(false)} ariaLabel="Revoked keys" width={640}>
        <div className="pr-8">
          <h2 className="text-[17px] font-semibold text-[var(--fg)]">Revoked keys</h2>
          <p className="mt-1 text-[13px] leading-5 text-[var(--muted-2)]">
            Revoked keys stop working immediately. They are kept here so you can see what was connected and when.
          </p>
        </div>
        <ul className="mt-4 divide-y divide-[var(--border)] rounded-xl border border-[var(--border)]">
          {revokedKeys.map((row) => (
            <KeyRow key={row.id} row={row} canManage={false} showOwner={!status?.isPersonalOrg} onRevoked={onRevoked} />
          ))}
        </ul>
      </Modal>

      {status && !canManage ? (
        <p className="mt-3 text-[12px] text-[var(--muted-2)]">Ask a workspace owner to create a key.</p>
      ) : null}
    </Panel>
  );
}
