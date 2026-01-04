"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clearSidebarCache } from "@/lib/sidebarCache";
import Button from "@/components/ui/Button";
import {
  clearLocalStorageKeysByPrefix,
  readLocalStorageSnapshot,
  removeLocalStorageKey,
  type LocalStorageRow,
} from "@/lib/admin/localStorageTools";

function safePreview(value: string, max = 180) {
  const v = value ?? "";
  if (v.length <= max) return v;
  return `${v.slice(0, max)}…`;
}

export default function CacheToolsClient() {
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
  const appKeys = useMemo(() => rows.filter((r) => r.key.startsWith("lnkdrp-")), [rows]);

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-[var(--fg)]">Local cache (localStorage)</div>
          <div className="mt-1 text-sm text-[var(--muted)]">
            {rows.length} keys • {totalBytes.toLocaleString()} bytes
          </div>
          <div className="mt-1 text-sm text-[var(--muted)]">{appKeys.length} app keys (lnkdrp-*) detected</div>
          {lastAction ? <div className="mt-2 text-sm text-[var(--fg)]">{lastAction}</div> : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            className="text-[13px]"
            disabled={busy}
            onClick={() => {
              setLastAction("Refreshed.");
              refresh();
            }}
          >
            Refresh
          </Button>

          <Button
            variant="solid"
            className="bg-black text-[13px] text-white hover:bg-black/90 disabled:hover:bg-black"
            disabled={busy}
            onClick={() => {
              if (!pendingClearAll) {
                setPendingClearAll(true);
                setPendingClearKey(null);
                armConfirmTimeout();
                setLastAction("Click again to confirm: clear app cache (lnkdrp-*)");
                return;
              }

              clearConfirmTimer();
              setPendingClearAll(false);

              setBusy(true);
              try {
                // Clear in-memory + persisted sidebar cache for all orgs first (affects running app immediately).
                clearSidebarCache({ all: true });

                const attempted = clearLocalStorageKeysByPrefix("lnkdrp-", ["lnkdrp-projects-collapsed"]);
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
            className="text-[13px]"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              try {
                clearSidebarCache({ all: true });
                clearLocalStorageKeysByPrefix("lnkdrp-", ["lnkdrp-projects-collapsed"]);
              } finally {
                window.location.reload();
              }
            }}
          >
            Clear + reload
          </Button>
        </div>
      </div>

      <div className="mt-4">
        <label className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">
          Filter by key
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="lnkdrp-sidebar-cache…"
            className="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-[13px] text-[var(--fg)] placeholder:text-[var(--muted-2)] focus:outline-none focus:ring-2 focus:ring-black/10 dark:focus:ring-white/10"
          />
        </label>
      </div>

      <div className="mt-4 overflow-hidden rounded-xl border border-[var(--border)]">
        {filtered.length ? (
          <ul className="divide-y divide-[var(--border)]">
            {filtered.map((r) => {
              const revealed = Boolean(revealedKeys[r.key]);
              const isPendingClear = pendingClearKey === r.key;
              return (
                <li key={r.key} className="bg-[var(--panel)] px-3 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-[13px] font-semibold text-[var(--fg)]">{r.key}</div>
                      <div className="mt-0.5 text-[12px] text-[var(--muted)]">
                        {r.bytes.toLocaleString()} bytes • {r.value && r.value.trim().startsWith("{") ? "json-ish" : "string"}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="bg-[var(--panel-2)] text-[12px]"
                        disabled={busy}
                        onClick={() =>
                          setRevealedKeys((prev) => ({ ...prev, [r.key]: !Boolean(prev[r.key]) }))
                        }
                      >
                        {revealed ? "Hide" : "Show"}
                      </Button>

                      <Button
                        variant="outline"
                        size="sm"
                        className="bg-[var(--panel-2)] text-[12px]"
                        disabled={busy}
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
                      </Button>
                    </div>
                  </div>

                  <div className="mt-2">
                    <pre className="whitespace-pre-wrap break-words rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-[12px] text-[var(--fg)]">
                      {revealed ? r.value : safePreview(r.value)}
                    </pre>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="px-3 py-6 text-sm text-[var(--muted)]">No localStorage keys found.</div>
        )}
      </div>

      <div className="mt-3 text-xs text-[var(--muted)]">
        Note: this page inspects browser localStorage on the current device. Values may include sensitive data; use with care.
      </div>
    </div>
  );
}


