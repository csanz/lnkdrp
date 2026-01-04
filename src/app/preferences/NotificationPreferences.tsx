/**
 * Notification preferences for `/preferences?tab=workspace`.
 *
 * Allows a workspace member to choose doc update email cadence (off/daily/immediate).
 */
"use client";

import { useEffect, useState } from "react";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";

type Mode = "off" | "daily" | "immediate";

export default function NotificationPreferences() {
  const [mode, setMode] = useState<Mode>("daily");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetchWithTempUser("/api/orgs/active/notification-preferences", { cache: "no-store" });
        if (!res.ok) throw new Error("Failed to load notification preferences");
        const json = (await res.json()) as any;
        const m = typeof json?.docUpdateEmailMode === "string" ? (json.docUpdateEmailMode as Mode) : "daily";
        if (!cancelled) setMode(m);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(next: Mode) {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetchWithTempUser("/api/orgs/active/notification-preferences", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ docUpdateEmailMode: next }),
      });
      if (!res.ok) throw new Error("Failed to save");
      setMode(next);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-[var(--fg)]">Doc update emails</div>
          <div className="mt-0.5 text-[12px] text-[var(--muted-2)]">
            Get notified when a doc is replaced and changes were introduced.
          </div>
        </div>

        <div className="flex items-center gap-2">
          <select
            className="h-9 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 text-[13px] font-semibold text-[var(--fg)]"
            value={mode}
            disabled={loading || saving}
            onChange={(e) => void save(e.target.value as Mode)}
            aria-label="Doc update email preference"
          >
            <option value="off">Off</option>
            <option value="daily">Daily digest</option>
            <option value="immediate">Immediately</option>
          </select>
          {saved ? <span className="text-[12px] font-medium text-emerald-600">Saved</span> : null}
        </div>
      </div>

      {error ? <div className="mt-3 text-[12px] font-medium text-red-700">{error}</div> : null}
      {!error ? (
        <div className="mt-3 text-[12px] text-[var(--muted-2)]">
          Daily digests are sent at the end of the day (workspace timezone). Immediate sends as soon as processing completes.
        </div>
      ) : null}
    </div>
  );
}


