/**
 * Admin route: `/a/tools/cache`
 *
 * What this browser is holding in localStorage, and the buttons that throw it away. The rows are
 * a table like every other admin list; a value is only unrolled under its row when asked for,
 * because a cache key's value is a JSON blob and five of them stacked hide the keys themselves.
 *
 * Destructive buttons still confirm by being clicked twice (window.confirm can be suppressed),
 * and that is unchanged — only the layout moved.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import Button from "@/components/ui/Button";
import {
  AdminFilterBar,
  AdminPageHeader,
  AdminSearchInput,
  AdminTable,
  AdminTableEmpty,
  AdminTd,
  AdminTh,
  AdminTr,
  RowAction,
  RowActions,
  StatusPill,
} from "@/components/admin";
import { ADMIN_CODE_BLOCK, ADMIN_NOTE } from "@/lib/admin/ui";
import { ADMIN_PAGE_CONTAINER } from "@/lib/admin/layout";
import { clearOrgsCache } from "@/lib/orgsCache";
import { clearSidebarCache } from "@/lib/sidebarCache";
import {
  clearLocalStorageKeysByPrefix,
  readLocalStorageSnapshot,
  removeLocalStorageKey,
  type LocalStorageRow,
} from "@/lib/admin/localStorageTools";

const COLUMN_COUNT = 5;

/** The head of a value, for the preview column. The full value is one click away. */
function safePreview(value: string, max = 180) {
  const v = value ?? "";
  if (v.length <= max) return v;
  return `${v.slice(0, max)}…`;
}

/** The local cache inspector: one row per localStorage key, with its value on demand. */
export default function AdminCacheToolsPage() {
  const [rows, setRows] = useState<LocalStorageRow[]>([]);
  const [revealedKeys, setRevealedKeys] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [lastAction, setLastAction] = useState<string | null>(null);

  // In-UI confirmation (avoids relying on window.confirm, which can be suppressed).
  const [pendingClearKey, setPendingClearKey] = useState<string | null>(null);
  const [pendingClearAll, setPendingClearAll] = useState(false);
  const confirmTimerRef = useRef<number | null>(null);

  const clearConfirmTimer = useCallback(() => {
    if (confirmTimerRef.current) {
      window.clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
  }, []);

  const armConfirmTimeout = useCallback(() => {
    clearConfirmTimer();
    confirmTimerRef.current = window.setTimeout(() => {
      setPendingClearKey(null);
      setPendingClearAll(false);
      confirmTimerRef.current = null;
    }, 5000);
  }, [clearConfirmTimer]);

  const refresh = useCallback(() => {
    setRows(readLocalStorageSnapshot());
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    return () => {
      clearConfirmTimer();
    };
  }, [clearConfirmTimer]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.key.toLowerCase().includes(q));
  }, [rows, filter]);

  const totalBytes = useMemo(() => rows.reduce((acc, r) => acc + r.bytes, 0), [rows]);
  const appKeys = useMemo(() => rows.filter((r) => r.key.startsWith("lnkdrp")), [rows]);

  return (
    <div className="min-h-[100svh] bg-[var(--bg)] text-[var(--fg)]">
      <div className={ADMIN_PAGE_CONTAINER}>
        <AdminPageHeader
          title="Cache"
          description={`This browser's localStorage on this device: ${rows.length.toLocaleString()} keys, ${appKeys.length.toLocaleString()} of them the app's, ${totalBytes.toLocaleString()} bytes in all.`}
          actions={
            <>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setLastAction("Refreshed.");
                  refresh();
                }}
              >
                Refresh
              </Button>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  if (!pendingClearAll) {
                    setPendingClearAll(true);
                    setPendingClearKey(null);
                    armConfirmTimeout();
                    setLastAction("Click again to confirm: clear app cache (lnkdrp*)");
                    return;
                  }

                  clearConfirmTimer();
                  setPendingClearAll(false);

                  setBusy(true);
                  try {
                    // Clear in-memory + persisted sidebar cache for all orgs first (affects running app immediately).
                    clearSidebarCache({ all: true });
                    // Clear in-memory + persisted orgs cache (so workspace switcher updates immediately).
                    clearOrgsCache();

                    const attempted = clearLocalStorageKeysByPrefix("lnkdrp");
                    // Update UI snapshot after the clear.
                    refresh();
                    setLastAction(`Cleared app cache. Attempted ${attempted.length.toLocaleString()} key(s).`);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {pendingClearAll ? "Confirm clear app cache" : "Clear app cache"}
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  try {
                    clearSidebarCache({ all: true });
                    clearOrgsCache();
                    clearLocalStorageKeysByPrefix("lnkdrp");
                  } finally {
                    window.location.reload();
                  }
                }}
              >
                Clear + reload
              </Button>
            </>
          }
        />

        <AdminFilterBar
          className="mt-4"
          actions={
            lastAction ? (
              <span className="text-[12px] leading-5 text-[var(--muted-2)]" role="status">
                {lastAction}
              </span>
            ) : null
          }
        >
          <AdminSearchInput
            value={filter}
            onValueChange={setFilter}
            placeholder="Filter by key…"
            ariaLabel="Filter cache keys"
          />
          <span className="text-[12px] leading-5 tabular-nums text-[var(--muted-2)]">
            {filtered.length.toLocaleString()} of {rows.length.toLocaleString()} keys
          </span>
        </AdminFilterBar>

        <AdminTable
          className="mt-3"
          ariaLabel="localStorage keys"
          head={
            <>
              <AdminTh>Key</AdminTh>
              <AdminTh>Shape</AdminTh>
              <AdminTh align="right">Bytes</AdminTh>
              <AdminTh>Preview</AdminTh>
              <AdminTh align="right" sticky>
                Actions
              </AdminTh>
            </>
          }
        >
          {filtered.length === 0 ? (
            <AdminTableEmpty
              colSpan={COLUMN_COUNT}
              title={filter.trim() ? "No keys match that filter" : "No localStorage keys on this device"}
              hint={filter.trim() ? "Try a shorter prefix, or clear the filter." : undefined}
            />
          ) : (
            filtered.map((r) => {
              const revealed = Boolean(revealedKeys[r.key]);
              const isPendingClear = pendingClearKey === r.key;
              const jsonish = Boolean(r.value && r.value.trim().startsWith("{"));
              const preview = safePreview(r.value);
              return (
                <AdminTr key={r.key}>
                  <AdminTd primary mono truncate="max-w-[280px]">
                    <span title={r.key}>{r.key}</span>
                  </AdminTd>
                  <AdminTd>
                    <StatusPill tone="quiet">{jsonish ? "json" : "string"}</StatusPill>
                  </AdminTd>
                  <AdminTd align="right" numeric>
                    {r.bytes.toLocaleString()}
                  </AdminTd>
                  <AdminTd mono truncate="max-w-[380px]">
                    <span title={preview}>{preview || "—"}</span>
                  </AdminTd>
                  <AdminTd align="right" sticky actions>
                    <RowActions>
                      <RowAction
                        disabled={busy}
                        aria-expanded={revealed}
                        title={revealed ? "Hide this value" : "Show the whole value"}
                        onClick={() => setRevealedKeys((prev) => ({ ...prev, [r.key]: !Boolean(prev[r.key]) }))}
                      >
                        {revealed ? "Hide" : "Show"}
                      </RowAction>
                      <RowAction
                        tone="danger"
                        disabled={busy}
                        title={`Remove ${r.key} from this browser`}
                        onClick={() => {
                          if (!isPendingClear) {
                            setPendingClearKey(r.key);
                            setPendingClearAll(false);
                            armConfirmTimeout();
                            setLastAction(`Click again to confirm: clear key ${r.key}`);
                            return;
                          }

                          clearConfirmTimer();
                          setPendingClearKey(null);

                          setBusy(true);
                          try {
                            const ok = removeLocalStorageKey(r.key);
                            // Optimistic UI update even if remove is blocked (refresh to reflect reality).
                            refresh();
                            setLastAction(ok ? `Cleared key: ${r.key}` : `Tried to clear key (may be blocked): ${r.key}`);
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        {isPendingClear ? "Confirm" : "Clear"}
                      </RowAction>
                    </RowActions>
                  </AdminTd>
                </AdminTr>
              );
            })
          )}
        </AdminTable>

        {/* The unrolled values sit outside the table: a row stays one line, and a 4KB blob is not a cell. */}
        {filtered
          .filter((r) => revealedKeys[r.key])
          .map((r) => (
            <div key={r.key} className="mt-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 truncate font-mono text-[12px] leading-5 text-[var(--fg)]" title={r.key}>
                  {r.key}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setRevealedKeys((prev) => ({ ...prev, [r.key]: false }))}
                >
                  Hide
                </Button>
              </div>
              <pre className={`mt-1.5 max-h-[320px] ${ADMIN_CODE_BLOCK}`}>{r.value}</pre>
            </div>
          ))}

        <p className={ADMIN_NOTE}>
          This reads the browser you are sitting at, not the server. Values can hold anything the app cached
          about the signed-in account, so treat what you reveal as sensitive.
        </p>
      </div>
    </div>
  );
}
