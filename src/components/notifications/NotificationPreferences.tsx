/**
 * Workspace member notification preferences UI.
 *
 * Used for configuring doc update email cadence (off/daily/immediate) for the active workspace.
 */
"use client";

import { useEffect, useState } from "react";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import { ORGS_CACHE_UPDATED_EVENT } from "@/lib/orgsCache";

type Mode = "off" | "daily" | "immediate";
type PrefKey = "docUpdateEmailMode" | "repoLinkRequestEmailMode";

type PrefsResponse = {
  ok: true;
  docUpdateEmailMode?: Mode;
  repoLinkRequestEmailMode?: Mode;
};

export default function NotificationPreferences() {
  const [docMode, setDocMode] = useState<Mode>("daily");
  const [repoMode, setRepoMode] = useState<Mode>("daily");
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<PrefKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<PrefKey | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetchWithTempUser("/api/orgs/active/notification-preferences", { cache: "no-store" });
        if (!res.ok) throw new Error("Failed to load notification preferences");
        const json = (await res.json()) as PrefsResponse | any;
        const nextDoc = typeof json?.docUpdateEmailMode === "string" ? (json.docUpdateEmailMode as Mode) : "daily";
        const nextRepo =
          typeof json?.repoLinkRequestEmailMode === "string" ? (json.repoLinkRequestEmailMode as Mode) : "daily";
        if (!cancelled) {
          setDocMode(nextDoc);
          setRepoMode(nextRepo);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    const onOrgsChanged = () => void load();
    window.addEventListener(ORGS_CACHE_UPDATED_EVENT, onOrgsChanged);
    return () => {
      cancelled = true;
      window.removeEventListener(ORGS_CACHE_UPDATED_EVENT, onOrgsChanged);
    };
  }, []);

  async function save(key: PrefKey, next: Mode) {
    setSavingKey(key);
    setError(null);
    setSavedKey(null);
    try {
      const res = await fetchWithTempUser("/api/orgs/active/notification-preferences", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [key]: next }),
      });
      if (!res.ok) throw new Error("Failed to save");
      if (key === "docUpdateEmailMode") setDocMode(next);
      if (key === "repoLinkRequestEmailMode") setRepoMode(next);
      setSavedKey(key);
      setTimeout(() => setSavedKey(null), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSavingKey(null);
    }
  }

  return (
    <div>
      <div className="grid gap-4">
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
              value={docMode}
              disabled={loading || savingKey !== null}
              onChange={(e) => void save("docUpdateEmailMode", e.target.value as Mode)}
              aria-label="Doc update email preference"
            >
              <option value="off">Off</option>
              <option value="daily">Daily digest</option>
              <option value="immediate">Immediately</option>
            </select>
            {savedKey === "docUpdateEmailMode" ? (
              <span className="text-[12px] font-medium text-emerald-600">Saved</span>
            ) : null}
          </div>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-[var(--fg)]">Repo link requests</div>
            <div className="mt-0.5 text-[12px] text-[var(--muted-2)]">
              Get notified when a repository link is requested or needs review.
            </div>
          </div>

          <div className="flex items-center gap-2">
            <select
              className="h-9 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 text-[13px] font-semibold text-[var(--fg)]"
              value={repoMode}
              disabled={loading || savingKey !== null}
              onChange={(e) => void save("repoLinkRequestEmailMode", e.target.value as Mode)}
              aria-label="Repo link request email preference"
            >
              <option value="off">Off</option>
              <option value="daily">Daily digest</option>
              <option value="immediate">Immediately</option>
            </select>
            {savedKey === "repoLinkRequestEmailMode" ? (
              <span className="text-[12px] font-medium text-emerald-600">Saved</span>
            ) : null}
          </div>
        </div>
      </div>

      {error ? <div className="mt-3 text-[12px] font-medium text-red-700">{error}</div> : null}
      {!error ? (
        <div className="mt-3 text-[12px] text-[var(--muted-2)]">
          Daily digests are sent at the end of the day (workspace timezone). Immediate sends as soon as processing
          completes.
        </div>
      ) : null}
    </div>
  );
}


