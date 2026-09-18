/**
 * Admin route: `/a/data/projects/:projectId`
 *
 * Project editor: inspect one project and mark it as a request repository. The identity
 * panel and the raw JSON block are the shared detail shapes; the request settings keep
 * their draft-then-Save behaviour exactly as before.
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Button from "@/components/ui/Button";
import {
  AdminAlert,
  AdminAccessState,
  AdminPageHeader,
  DetailGrid,
  DetailPanel,
  DetailRow,
  IdCell,
  JsonBlock,
  StatusPill,
  useAdminAccess,
} from "@/components/admin";
import { ADMIN_PAGE_CONTAINER } from "@/lib/admin/layout";
import { fetchJson } from "@/lib/http/fetchJson";

type ProjectRaw = Record<string, unknown>;

/** The project editor page. */
export default function AdminProjectEditorPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = decodeURIComponent(params?.projectId ?? "").trim();

  const access = useAdminAccess();
  const canUseAdmin = access.canUseAdmin;

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMessage, setOkMessage] = useState<string | null>(null);
  const [raw, setRaw] = useState<ProjectRaw | null>(null);

  const token = useMemo(() => {
    const t = raw?.requestUploadToken;
    return typeof t === "string" ? t : null;
  }, [raw]);
  const currentIsRequest = useMemo(() => Boolean(raw?.isRequest), [raw]);

  const [draftIsRequest, setDraftIsRequest] = useState<boolean>(false);

  useEffect(() => {
    setDraftIsRequest(currentIsRequest);
  }, [currentIsRequest]);

  useEffect(() => {
    if (!canUseAdmin) return;
    if (!projectId) return;
    setLoading(true);
    setError(null);
    setOkMessage(null);
    void (async () => {
      try {
        const data = await fetchJson<{ project?: { raw?: unknown } }>(
          `/api/admin/data/projects/${encodeURIComponent(projectId)}`,
          { method: "GET" },
        );
        const r = data.project?.raw;
        setRaw(r && typeof r === "object" ? (r as ProjectRaw) : null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load project");
        setRaw(null);
      } finally {
        setLoading(false);
      }
    })();
  }, [canUseAdmin, projectId]);

  /** Persist the drafted `isRequest` flag, then re-read the project. */
  async function onSave() {
    setError(null);
    setOkMessage(null);
    if (!projectId) return;
    setSaving(true);
    try {
      await fetchJson(`/api/admin/data/projects/${encodeURIComponent(projectId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isRequest: draftIsRequest }),
      });
      setOkMessage("Saved.");
      // Refresh raw so admin sees persisted truth.
      const againJson = await fetchJson<{ project?: { raw?: unknown } }>(
        `/api/admin/data/projects/${encodeURIComponent(projectId)}`,
        { method: "GET" },
      );
      const r = againJson.project?.raw;
      setRaw(r && typeof r === "object" ? (r as ProjectRaw) : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update project");
    } finally {
      setSaving(false);
    }
  }

  /** Mint a request upload token for this project (confirms first), then re-read it. */
  async function convertToRequestRepo() {
    setError(null);
    setOkMessage(null);
    if (!projectId) return;
    const ok = window.confirm("Convert this project into a request repository?\n\nThis will generate a request upload token and set isRequest=true.");
    if (!ok) return;
    setSaving(true);
    try {
      await fetchJson(`/api/admin/data/projects/${encodeURIComponent(projectId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ convertToRequest: true }),
      });
      setOkMessage("Converted to request repository.");
      const againJson = await fetchJson<{ project?: { raw?: unknown } }>(
        `/api/admin/data/projects/${encodeURIComponent(projectId)}`,
        { method: "GET" },
      );
      const r = againJson.project?.raw;
      setRaw(r && typeof r === "object" ? (r as ProjectRaw) : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to convert project");
    } finally {
      setSaving(false);
    }
  }

  if (!canUseAdmin) {
    return <AdminAccessState access={access} title="Project" description="Inspect one project and mark it as a request repository." callbackUrl={`/a/data/projects/${encodeURIComponent(projectId)}`} />;
  }

  return (
    <div className="min-h-[100svh] bg-[var(--bg)] text-[var(--fg)]">
      <div className={ADMIN_PAGE_CONTAINER}>
        <AdminPageHeader
          title="Project"
          description="Inspect one project and mark it as a request repository."
          /* Only the exception is worth a chip: an ordinary project says nothing here. */
          actions={currentIsRequest ? <StatusPill tone="info">Request repo</StatusPill> : null}
        />

        {error ? (
          <AdminAlert className="mt-3">
            {error}
          </AdminAlert>
        ) : null}

        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {/* The same two fields this page has always shown — the rest lives in the raw document below. */}
          <DetailPanel title="Identifiers" description="What names this project to the API and to uploaders.">
            <DetailGrid>
              <DetailRow label="Project ID">
                <IdCell value={projectId} label="project id" />
              </DetailRow>
              <DetailRow label="Request token">
                <IdCell value={token} label="request upload token" head={10} tail={4} />
              </DetailRow>
            </DetailGrid>
          </DetailPanel>

          <DetailPanel
            title="Request repository"
            description="Marks this project as a request repository (Received)."
            actions={
              <Button
                variant="solid"
                size="sm"
                disabled={saving || loading || (draftIsRequest && !token)}
                onClick={() => void onSave()}
              >
                {saving ? "Saving…" : "Save"}
              </Button>
            }
            bodyClassName="p-3"
          >
            <label className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2.5">
              <span className="min-w-0">
                <span className="block text-[13px] font-medium leading-5 text-[var(--fg)]">isRequest</span>
                <span className="mt-0.5 block text-[12px] leading-4 text-[var(--muted-2)]">
                  Uploads at <code className="font-mono">/request/:token</code> need this on.
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <StatusPill tone={draftIsRequest ? "info" : "quiet"}>{draftIsRequest ? "On" : "Off"}</StatusPill>
                <input
                  type="checkbox"
                  checked={draftIsRequest}
                  onChange={(e) => setDraftIsRequest(e.target.checked)}
                  aria-label="Mark this project as a request repository"
                  className="h-4 w-4 accent-[var(--fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fg)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--panel)]"
                />
              </span>
            </label>

            {!token ? (
              <div className="mt-2 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2.5">
                <p className="min-w-0 text-[12px] leading-5 text-[var(--muted-2)]">
                  No request token yet. Converting generates one and sets isRequest=true.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={saving || loading}
                  onClick={() => void convertToRequestRepo()}
                >
                  Convert to request repo
                </Button>
              </div>
            ) : null}

            {okMessage ? (
              <p className="mt-2 px-1 text-[12px] leading-5 text-[var(--muted-2)]">{okMessage}</p>
            ) : null}
          </DetailPanel>
        </div>

        <DetailPanel
          className="mt-3"
          title="Raw project document"
          description="Everything stored on this project, straight from Mongo."
          bodyClassName="p-2"
        >
          <JsonBlock
            text={loading ? "Loading…" : JSON.stringify(raw ?? null, null, 2)}
            maxHeight="max-h-[420px]"
          />
        </DetailPanel>
      </div>
    </div>
  );
}
