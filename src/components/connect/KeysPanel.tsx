"use client";

import { useState } from "react";

import { refreshAgentStatus, type AgentKeyRow, type AgentStatus } from "@/lib/client/useAgentStatus";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import Modal from "@/components/modals/Modal";
import { CreateKeyForm, PRIMARY_BUTTON, QUIET_BUTTON, errorMessage } from "./CreateKey";
import Panel from "./Panel";
import { formatDate, formatRelative } from "./format";

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
      <div className="min-w-[14rem] flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px]">
          <span className="font-medium text-[var(--fg)]">{row.name}</span>
          {row.kind === "oauth" ? (
            <span className="rounded-md px-1.5 py-px text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--muted-2)] ring-1 ring-[var(--border)]" title="Connected by signing in, not with a key">
              Signed in
            </span>
          ) : (
            <code className="font-mono text-[12px] text-[var(--muted-2)]">{row.prefix}…</code>
          )}
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
      {!row.revoked && row.kind !== "oauth" && onUse && !inUse && !confirming ? (
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
          // Own row under the key so the question does not fight the buttons for one line.
          <div className="flex basis-full flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2.5">
            <span className="min-w-0 flex-1 text-[12px] leading-5 text-[var(--muted)]">
              <span className="font-medium text-[var(--fg)]">{row.kind === "oauth" ? "Disconnect this agent?" : "Revoke this key?"}</span>{" "}
              {row.kind === "oauth"
                ? "It stops working at once. To reconnect, remove lnkdrp in that client and add it again; it will ask you to sign in."
                : "Clients using it stop working until you remove lnkdrp there and add it again with a new key. Step 2 explains how."}
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <button type="button" onClick={() => void revoke()} disabled={busy} className={PRIMARY_BUTTON}>
                {busy ? "Revoking…" : "Revoke"}
              </button>
              <button type="button" onClick={() => setConfirming(false)} disabled={busy} className={QUIET_BUTTON}>
                Cancel
              </button>
            </span>
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
 * Keys and agents on the Connect page: every credential in the workspace (keys by prefix, signed-in
 * agents marked as such), revoke for owners and admins, and a "Create key" action that opens the
 * shared `CreateKeyForm`. The plaintext is not shown here: the parent gets it through `onCreated`
 * and reveals it in the "Create a key" step, next to the commands that use it.
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
  const [error, setError] = useState<string | null>(null);

  const canManage = Boolean(status?.canManage);
  const keys = status?.keys ?? [];
  // Active keys stay in the panel; revoked ones move behind a link so step 2 is never pushed down
  // by history. The modal keeps the full audit trail one click away.
  const activeKeys = keys.filter((k) => !k.revoked);
  const revokedKeys = keys.filter((k) => k.revoked);
  /**
   * Show who created a key only when that distinguishes anything.
   *
   * This used to be `!status?.isPersonalOrg` — the owner column was hidden in a personal workspace
   * because a personal workspace could only ever hold one person. It can hold collaborators now
   * (the gate is the plan, not the workspace type), so that test would hide exactly the column a
   * shared personal workspace needs. Counting the distinct creators answers the real question and
   * is right for every workspace type: one creator, no column.
   */
  const showKeyOwner = new Set(keys.map((k) => ownerName(k.createdBy) ?? "")).size > 1;
  const [revokedOpen, setRevokedOpen] = useState(false);
  const activeCount = keys.filter((k) => !k.revoked).length;

  // "Revoke all": every active key in one go, for when you want every agent connection dead now.
  // Revokes sequentially through the same endpoint so the activity feed gets one row per key.
  const [revokeAllOpen, setRevokeAllOpen] = useState(false);
  const [revokingAll, setRevokingAll] = useState(false);
  const revokeAll = async () => {
    setRevokingAll(true);
    setError(null);
    try {
      for (const k of activeKeys) {
        const res = await fetchWithTempUser(`/api/agent/keys/${encodeURIComponent(k.id)}`, { method: "DELETE" });
        if (!res.ok && res.status !== 404) {
          const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
          throw new Error(errorMessage(res.status, body, "Could not revoke every key."));
        }
        onRevoked(k.id);
      }
      refreshAgentStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not revoke every key.");
    } finally {
      setRevokingAll(false);
      setRevokeAllOpen(false);
    }
  };

  const action =
    canManage && !formOpen ? (
      <div className="flex items-center gap-2">
        {activeCount > 1 ? (
          revokeAllOpen ? (
            <>
              <span className="text-[12px] text-[var(--muted)]">Revoke all {activeCount} keys?</span>
              <button type="button" onClick={() => void revokeAll()} disabled={revokingAll} className={QUIET_BUTTON}>
                {revokingAll ? "Revoking…" : "Revoke all"}
              </button>
              <button type="button" onClick={() => setRevokeAllOpen(false)} disabled={revokingAll} className={QUIET_BUTTON}>
                Cancel
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setRevokeAllOpen(true)} className={QUIET_BUTTON} title="Revoke every active key; all agent connections stop">
              Revoke all
            </button>
          )
        ) : null}
        <button type="button" onClick={() => { setFormOpen(true); setError(null); }} className={PRIMARY_BUTTON}>
          Create key
        </button>
      </div>
    ) : null;

  return (
    <Panel id="keys" title="Keys and agents" caption={status ? `${activeCount} active` : undefined} action={action}>
      {formOpen ? (
        <CreateKeyForm
          className="mb-4"
          onCreated={(plaintext, key) => {
            onCreated(plaintext, key);
            setFormOpen(false);
          }}
          onCancel={() => setFormOpen(false)}
        />
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
              showOwner={showKeyOwner}
              inUse={Boolean(row.kind !== "oauth" && plaintextKey && plaintextKey.startsWith(row.prefix))}
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
            <KeyRow key={row.id} row={row} canManage={false} showOwner={showKeyOwner} onRevoked={onRevoked} />
          ))}
        </ul>
      </Modal>

      {status && !canManage ? (
        <p className="mt-3 text-[12px] text-[var(--muted-2)]">Ask a workspace owner to create a key.</p>
      ) : null}
    </Panel>
  );
}
