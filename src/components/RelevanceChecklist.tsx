"use client";

import { useMemo, useSyncExternalStore } from "react";

type Props = {
  storageKey: string;
  items: string[];
};

export default function RelevanceChecklist({ storageKey, items }: Props) {
  const normalized = useMemo(() => {
    const xs = (items ?? []).filter((t) => typeof t === "string" && t.trim());
    return xs.length ? xs : ["Relevant to me"];
  }, [items]);

  function subscribe(callback: () => void) {
    // Keep multiple tabs and same-tab writes in sync.
    window.addEventListener("storage", callback);
    window.addEventListener("lnkdrp:relevance-checklist", callback);
    return () => {
      window.removeEventListener("storage", callback);
      window.removeEventListener("lnkdrp:relevance-checklist", callback);
    };
  }

  function getSnapshot() {
    try {
      return window.localStorage.getItem(storageKey) ?? "";
    } catch {
      return "";
    }
  }

  function getServerSnapshot() {
    // SSR-safe. Component is client-only, but required by the hook signature.
    return "";
  }

  const raw = useSyncExternalStore(
    subscribe,
    () => getSnapshot(),
    () => getServerSnapshot(),
  );

  const checked = useMemo(() => {
    if (!raw) return {} as Record<string, boolean>;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object") return {};
      const next: Record<string, boolean> = {};
      for (const k of Object.keys(parsed as Record<string, unknown>)) {
        next[k] = Boolean((parsed as Record<string, unknown>)[k]);
      }
      return next;
    } catch {
      return {};
    }
  }, [raw]);

  function setChecked(label: string, value: boolean) {
    const next = { ...checked, [label]: value };
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
      window.dispatchEvent(new Event("lnkdrp:relevance-checklist"));
    } catch {
      // ignore
    }
  }

  return (
    <div className="mt-5 rounded-2xl border border-zinc-200 bg-white p-5">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-sm font-semibold">Relevance</div>
        <div className="text-xs font-medium text-zinc-500">Private to you</div>
      </div>
      <div className="mt-2 text-xs text-zinc-500">
        Check what feels relevant; this doesn’t notify the sender.
      </div>

      <div className="mt-3 space-y-2">
        {normalized.map((label) => (
          <label
            key={label}
            className="flex cursor-pointer select-none items-center gap-3 rounded-xl border border-zinc-200 bg-white px-3 py-2"
          >
            <input
              type="checkbox"
              checked={Boolean(checked[label])}
              onChange={(e) =>
                setChecked(label, e.target.checked)
              }
              className="h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900"
            />
            <span className="text-sm font-medium text-zinc-900">{label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}





