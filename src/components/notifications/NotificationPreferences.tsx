/**
 * Workspace member notification preferences UI.
 *
 * Configures the member's email cadence (off/daily/immediate) for the active workspace: link opens
 * (view emails, listed first because it is the one people come for), doc updates and repo link requests.
 */
"use client";

import PreferenceExplainer from "@/components/notifications/PreferenceExplainer";
import { useEffect, useState } from "react";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import { ORGS_CACHE_UPDATED_EVENT } from "@/lib/orgsCache";

/** Request repos ship behind a flag; the same build-time flag the sidebar and /requests read. */
const FEATURE_REQUESTS_ENABLED = process.env.NEXT_PUBLIC_FEATURE_REQUESTS === "1";

type Mode = "off" | "daily" | "immediate";
type PrefKey = "viewEmailMode" | "briefEmailMode" | "docUpdateEmailMode" | "docUploadEmailMode" | "repoLinkRequestEmailMode";

type PrefsResponse = {
  ok: true;
  viewEmailMode?: Mode;
  briefEmailMode?: Mode;
  docUpdateEmailMode?: Mode;
  repoLinkRequestEmailMode?: Mode;
};

export default function NotificationPreferences() {
  const [viewMode, setViewMode] = useState<Mode>("daily");
  const [briefMode, setBriefMode] = useState<Mode>("immediate");
  const [docMode, setDocMode] = useState<Mode>("daily");
  const [uploadMode, setUploadMode] = useState<Mode>("daily");
  const [repoMode, setRepoMode] = useState<Mode>("daily");
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<PrefKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<PrefKey | null>(null);
  /**
   * Whether an AI run can go ahead right now. The brief is the one email here that costs a credit,
   * so a workspace with none should read that its briefs are paused, next to the switch, rather
   * than learn it from a recap email later. Null until known; nothing is claimed until then.
   */
  const [creditsPaused, setCreditsPaused] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithTempUser("/api/credits/snapshot", { cache: "no-store" });
        const json = (await res.json().catch(() => null)) as { ok?: boolean; blocked?: boolean; spendableRemaining?: number | null } | null;
        if (!res.ok || !json?.ok) return;
        const spendable = typeof json.spendableRemaining === "number" ? json.spendableRemaining : null;
        if (!cancelled) setCreditsPaused(Boolean(json.blocked) || (spendable !== null && spendable <= 0));
      } catch {
        // Unknown stays unknown; the row simply shows no note.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetchWithTempUser("/api/orgs/active/notification-preferences", { cache: "no-store" });
        if (!res.ok) throw new Error("Failed to load notification preferences");
        const json = (await res.json()) as PrefsResponse | any;
        const nextView = typeof json?.viewEmailMode === "string" ? (json.viewEmailMode as Mode) : "daily";
        const nextBrief = typeof json?.briefEmailMode === "string" ? (json.briefEmailMode as Mode) : "immediate";
        const nextDoc = typeof json?.docUpdateEmailMode === "string" ? (json.docUpdateEmailMode as Mode) : "daily";
        const nextUpload = typeof json?.docUploadEmailMode === "string" ? (json.docUploadEmailMode as Mode) : "daily";
        const nextRepo =
          typeof json?.repoLinkRequestEmailMode === "string" ? (json.repoLinkRequestEmailMode as Mode) : "daily";
        if (!cancelled) {
          setViewMode(nextView);
          setBriefMode(nextBrief);
          setDocMode(nextDoc);
          setUploadMode(nextUpload);
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
      if (key === "viewEmailMode") setViewMode(next);
      if (key === "briefEmailMode") setBriefMode(next);
      if (key === "docUpdateEmailMode") setDocMode(next);
    if (key === "docUploadEmailMode") setUploadMode(next);
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
    // `email-preferences`: the anchor the view emails' "Change how often" link lands on.
    <div id="email-preferences">
      <div className="grid gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <div className="text-[13px] font-semibold text-[var(--fg)]">When someone opens a link</div>
              <PreferenceExplainer topic="views" />
            </div>
            <div className="mt-0.5 text-[12px] text-[var(--muted-2)]">
              Get notified when a recipient opens one of this workspace&apos;s share links.
            </div>
          </div>

          <div className="flex items-center gap-2">
            <select
              className="h-9 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 text-[13px] font-semibold text-[var(--fg)]"
              value={viewMode}
              disabled={loading || savingKey !== null}
              onChange={(e) => void save("viewEmailMode", e.target.value as Mode)}
              aria-label="Link open email preference"
            >
              <option value="off">Off</option>
              <option value="daily">Daily digest</option>
              <option value="immediate">Immediately</option>
            </select>
            {savedKey === "viewEmailMode" ? (
              <span className="text-[12px] font-medium text-emerald-600">Saved</span>
            ) : null}
          </div>
        </div>

        {/* The brief: the sibling of the open email above, and the one people keep once they have
            seen it. Right under it so the pair reads as what it is — the start and the end of a
            visit — and the line under the dropdown says how to have just one of the two. */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <div className="text-[13px] font-semibold text-[var(--fg)]">When someone finishes reading</div>
              <PreferenceExplainer topic="briefs" />
            </div>
            <div className="mt-0.5 text-[12px] text-[var(--muted-2)]">
              A short AI brief of the visit, a few minutes after the reader is done: what held them, what they skipped. Pro; one credit per visit.
              Prefer one email per visit? Keep this and turn the link-open email off.
            </div>
            {creditsPaused ? (
              <div className="mt-1.5 text-[12px] font-medium text-[var(--plan-ending-fg)]">
                Paused: this workspace is out of credits, so no briefs are being written. You still get the facts of each visit by email; the write-up resumes when you{" "}
                <a href="/credits" className="underline underline-offset-2">
                  add credits
                </a>
                .
              </div>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            <select
              className="h-9 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 text-[13px] font-semibold text-[var(--fg)]"
              value={briefMode}
              disabled={loading || savingKey !== null}
              onChange={(e) => void save("briefEmailMode", e.target.value as Mode)}
              aria-label="Visit brief email preference"
            >
              <option value="off">Off</option>
              <option value="daily">Daily digest</option>
              <option value="immediate">After each visit</option>
            </select>
            {savedKey === "briefEmailMode" ? (
              <span className="text-[12px] font-medium text-emerald-600">Saved</span>
            ) : null}
          </div>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <div className="text-[13px] font-semibold text-[var(--fg)]">Doc update emails</div>
              <PreferenceExplainer topic="docUpdates" />
            </div>
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
            <div className="flex items-center gap-1.5">
              <div className="text-[13px] font-semibold text-[var(--fg)]">New documents from teammates</div>
              <PreferenceExplainer topic="docUploads" />
            </div>
            <div className="mt-0.5 text-[12px] text-[var(--muted-2)]">
              Get notified when someone else in this workspace adds a document.
            </div>
          </div>

          <div className="flex items-center gap-2">
            <select
              className="h-9 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 text-[13px] font-semibold text-[var(--fg)]"
              value={uploadMode}
              disabled={loading || savingKey !== null}
              onChange={(e) => void save("docUploadEmailMode", e.target.value as Mode)}
              aria-label="New document email preference"
            >
              <option value="off">Off</option>
              <option value="daily">Daily digest</option>
              <option value="immediate">Immediately</option>
            </select>
            {savedKey === "docUploadEmailMode" ? (
              <span className="text-[12px] font-medium text-emerald-600">Saved</span>
            ) : null}
          </div>
        </div>

        {/* Request repos are behind NEXT_PUBLIC_FEATURE_REQUESTS; without them there is nothing to
            be notified about, so the row is hidden rather than offering a dead preference. */}
        {FEATURE_REQUESTS_ENABLED ? (
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
        ) : null}
      </div>

      {error ? <div className="mt-3 text-[12px] font-medium text-red-700">{error}</div> : null}
      {!error ? (
        <div className="mt-3 text-[12px] text-[var(--muted-2)]">
          Daily digests are sent once a day, at the end of the day (UTC). Immediate emails arrive within a few
          minutes.
        </div>
      ) : null}
    </div>
  );
}


