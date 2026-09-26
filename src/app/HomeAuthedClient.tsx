"use client";

import AppPageHeader, { APP_PAGE_GUTTER } from "@/components/AppPageHeader";
import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowUpTrayIcon, CpuChipIcon, DocumentPlusIcon, LinkIcon, LockClosedIcon } from "@heroicons/react/24/outline";
import { lockedOptionLabel } from "@/components/project/ProjectLockIcon";
import UploadButton from "@/components/UploadButton";
import FirstRunWelcome from "@/components/onboarding/FirstRunWelcome";
import AgentHintNotice from "@/components/AgentHintNotice";
import AgentMark from "@/components/AgentMark";
import { usePlan } from "@/lib/client/usePlan";
import { useAgentStatus } from "@/lib/client/useAgentStatus";
import AppShellLayout from "./(app)/AppShellLayout";
import { PlanLimitClientError, apiCreateDoc, apiCreateUpload, isPdfFile, PDF_ONLY_MESSAGE } from "@/lib/client/docUploadPipeline";
import { useUpgradeModal } from "@/components/UpgradeModalProvider";
import { FREE_PLAN_LIMITS_COPY, planLimitGraceHint } from "@/lib/client/planLimit";
import { usePendingUpload } from "@/lib/pendingUpload";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import { fetchJson } from "@/lib/http/fetchJson";
import { showSwitchingOverlay, switchWorkspaceWithOverlay, UPLOAD_NAV_OVERLAY_ID } from "@/components/SwitchingOverlay";
/**
 * File Name From Url (uses trim, pop, filter).
 */


function fileNameFromUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const last = (u.pathname.split("/").filter(Boolean).pop() ?? "document.pdf").trim();
    // Ensure it ends with .pdf for nicer titles.
    return last.toLowerCase().endsWith(".pdf") ? last : `${last || "document"}.pdf`;
  } catch {
    return "document.pdf";
  }
}
/**
 * The signed-in home: `/` wraps it in the app shell, and `/upload` renders it when no file is staged,
 * so both addresses show the same upload screen.
 */
export default function HomeAuthedClient() {
  return (
    <AppShellLayout>
      <UploadHome />
    </AppShellLayout>
  );
}

/**
 * The upload screen itself: drop zone, import from a link, and the agent card.
 *
 * `onUploadRoute` is set when it is rendered by `/upload`. Staging a file there must not show the
 * "Preparing upload" overlay or push to `/upload`: the address would not change, and that overlay is
 * only cleared on a route change (providers.tsx), so it would stay up forever. The page picks the
 * staged file up from `usePendingUpload` and switches to its preview instead.
 */
export type UploadProjectOption = {
  id: string;
  name: string;
  /** "locked" is a private data room. A `<select>` cannot hold a padlock, so the option says it. */
  visibility?: "workspace" | "locked";
};

/** What the "Add to a data room" picker needs: the list, the choice, and the id that is safe to send. */
export type UploadProjectPickerState = {
  /** `null` until the list has loaded, and again if it failed (the picker hides itself). */
  options: UploadProjectOption[] | null;
  projectId: string | null;
  setProjectId: (id: string | null) => void;
  /** The chosen id only when it is in the loaded list, so an unknown `?project=` never 400s an upload. */
  effectiveProjectId: string | null;
  /** "Only inside this data room" (PRD decision 7): the doc is listed in the room, not the workspace. */
  contained: boolean;
  setContained: (v: boolean) => void;
  /** `"project"` only when a project is actually chosen and `contained` is on; what to send as `visibility`. */
  effectiveVisibility: "workspace" | "project";
};

/**
 * Projects a new document can be created inside (request inboxes are not in the lite list), preselected
 * from `?project=<id>` in the URL. Best-effort: a failed load leaves `options` null and the upload
 * proceeds into the workspace. `enabled: false` skips the fetch when a parent owns the state instead.
 */
export function useUploadProjectPicker({ enabled = true }: { enabled?: boolean } = {}): UploadProjectPickerState {
  const searchParams = useSearchParams();
  const projectFromUrl = (searchParams?.get("project") ?? "").trim();
  const [options, setOptions] = useState<UploadProjectOption[] | null>(null);
  const [projectId, setProjectId] = useState<string | null>(projectFromUrl || null);
  const [contained, setContained] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchJson<{ projects?: Array<{ id?: unknown; name?: unknown; visibility?: unknown }> }>(
          "/api/projects?limit=50&page=1&lite=1",
          { method: "GET" },
        );
        const list: UploadProjectOption[] = [];
        for (const p of Array.isArray(res?.projects) ? res.projects : []) {
          if (typeof p?.id === "string" && p.id && typeof p?.name === "string") {
            list.push({ id: p.id, name: p.name, visibility: p.visibility === "locked" ? "locked" : "workspace" });
          }
        }
        if (!cancelled) setOptions(list);
      } catch {
        if (!cancelled) setOptions(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const effectiveProjectId = projectId && options?.some((o) => o.id === projectId) ? projectId : null;
  const effectiveVisibility: "workspace" | "project" = effectiveProjectId && contained ? "project" : "workspace";
  return { options, projectId, setProjectId, effectiveProjectId, contained, setContained, effectiveVisibility };
}

/**
 * The small "Add to a data room" select. Renders nothing while the list is loading, when it failed, or
 * when the workspace has no projects: the upload never waits on it.
 */
export function UploadProjectPicker({
  picker,
  disabled = false,
  className = "",
}: {
  picker: UploadProjectPickerState;
  disabled?: boolean;
  className?: string;
}) {
  const selectId = useId();
  const containedId = useId();
  const { options, projectId, setProjectId, contained, setContained } = picker;
  if (!options || !options.length) return null;
  const value = projectId && options.some((o) => o.id === projectId) ? projectId : "";
  return (
    <div className={["flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-[var(--muted)]", className].join(" ")}>
      <label htmlFor={selectId} className="shrink-0">
        Add to a data room
      </label>
      <select
        id={selectId}
        value={value}
        disabled={disabled}
        onChange={(e) => setProjectId(e.target.value || null)}
        className="h-8 min-w-0 max-w-full rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2 text-[12px] text-[var(--fg)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)] disabled:opacity-60"
      >
        <option value="">No data room (workspace)</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {/* The padlock in words: a private room in this list is a room the workspace cannot see,
                and a picker that hid that would file a document somewhere the uploader did not
                expect. */}
            {lockedOptionLabel(o.name, o.visibility === "locked")}
          </option>
        ))}
      </select>
      {/* Contained document (PRD decision 7): only meaningful once a room is chosen. Takes its own
          line under the select (`basis-full`) so the caller's row alignment still applies above. */}
      {value ? (
        <div className="flex basis-full items-start gap-x-2 pt-0.5">
          <input
            id={containedId}
            type="checkbox"
            checked={contained}
            disabled={disabled}
            onChange={(e) => setContained(e.target.checked)}
            className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded border-[var(--border)] accent-[var(--fg)] disabled:opacity-60"
          />
          <label htmlFor={containedId} className="flex flex-col gap-y-0.5">
            <span className="text-[var(--fg)]">Only inside this data room</span>
            <span className="text-[11px] text-[var(--muted-2)]">Listed in the room, not in the workspace. Its link still works.</span>
          </label>
        </div>
      ) : null}
    </div>
  );
}

export function UploadHome({
  onUploadRoute = false,
  projectPicker,
}: {
  onUploadRoute?: boolean;
  /** `/upload` owns the picker so the choice survives into the preview; on `/` this component owns it. */
  projectPicker?: UploadProjectPickerState;
}) {
  const router = useRouter();
  const ownProjectPicker = useUploadProjectPicker({ enabled: !projectPicker });
  const picker = projectPicker ?? ownProjectPicker;
  const { openUpgrade } = useUpgradeModal();
  const { pendingFile, setPendingFile, setHasEnteredShell } = usePendingUpload();
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const lastAutoHandledRef = useRef<File | null>(null);
  const [urlInput, setUrlInput] = useState("");
  const [urlBusy, setUrlBusy] = useState(false);
  const pushingUploadRef = useRef(false);
  const dragDepthRef = useRef(0);
  const { plan } = usePlan();
  // Shares the sidebar's cached status (the sidebar owns the refresh); no polling from this page.
  const { status: agentStatus } = useAgentStatus();

  function startUploadNavNow() {
    if (onUploadRoute) return;
    // Show an immediate full-screen overlay before routing to `/upload`
    // so the user never sees a "dead" period after file selection.
    showSwitchingOverlay({
      id: UPLOAD_NAV_OVERLAY_ID,
      title: "Preparing upload…",
      subtitle: "Loading your preview.",
    });
  }

  function pushUploadRouteSoon() {
    if (onUploadRoute) return;
    // The data room chosen here rides along in the URL, where `/upload` preselects it.
    const target = picker.effectiveProjectId ? `/upload?project=${encodeURIComponent(picker.effectiveProjectId)}` : "/upload";
    // Let the overlay paint before the route transition begins.
    if (typeof window === "undefined") {
      router.push(target);
      return;
    }
    window.requestAnimationFrame(() => router.push(target));
  }

  async function waitForNextPaint() {
    if (typeof window === "undefined") return;
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  }

  // no-op (preview is handled on `/upload`)

  /**
   * If the user just created an org and re-authed, there may be a short window where the
   * browser has not yet switched into the new org (claim-join + /org/switch redirect).
   *
   * Starting an upload during that window can create the doc in the "old" org, then
   * the app switches org and `/api/docs/:id` returns 404 forever.
   *
   * This is a best-effort guard: if a join can be claimed, redirect to `/org/switch`
   * and abort the upload.
   */
  async function ensureOrgReadyForUpload() {
    try {
      const res = await fetchJson<{ claimed?: boolean; orgId?: string }>("/api/orgs/claim-join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const orgId = typeof res?.orgId === "string" ? res.orgId : "";
      if (res?.claimed && orgId && typeof window !== "undefined") {
        const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
        try {
          await switchWorkspaceWithOverlay({ orgId, returnTo });
        } catch {
          window.location.assign(`/org/switch?orgId=${encodeURIComponent(orgId)}&returnTo=${encodeURIComponent(returnTo)}`);
        }
        throw new Error("Switching workspace…");
      }
    } catch (e) {
      // If we're redirecting, surface a friendly message; otherwise ignore (best-effort).
      const message = e instanceof Error ? e.message : "";
      if (message === "Switching workspace…") throw e;
    }
  }

  useEffect(() => {
    setHasEnteredShell(true);
  }, [setHasEnteredShell]);
/**
 * Handle Url Submit (updates state (setError, setUrlBusy); uses setError, trim, setUrlBusy).
 */


  async function handleUrlSubmit() {
    if (urlBusy) return;
    setError(null);

    const raw = urlInput.trim();
    if (!raw) {
      setError("Paste a PDF link.");
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      setError("That doesn’t look like a valid URL.");
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      setError("Only http(s) links are supported.");
      return;
    }

    setUrlBusy(true);
    /**
     * The document is created before the link is fetched (the import route attaches bytes to an
     * existing upload), so a bad link used to leave an "Untitled document" behind every time. On
     * any failure after creation the document is deleted again (code review 2026-09-23, M31). A
     * tab closed mid-fetch still leaves one; only creating after the fetch would close that.
     */
    let createdDocId: string | null = null;
    try {
      // Ensure the "Fetching…" UI renders immediately before we do any async work.
      await waitForNextPaint();
      await ensureOrgReadyForUpload();
      const inferredName = fileNameFromUrl(raw);
      // For URL uploads, don't name the doc from the URL path (e.g. ".../view" → "view").
      // Start with a neutral placeholder; the processing pipeline will rename using AI `docName`.
      const docId = await apiCreateDoc({
        title: "Untitled document",
        projectId: picker.effectiveProjectId,
        visibility: picker.effectiveVisibility,
      });
      createdDocId = docId;
      const upload = await apiCreateUpload({
        docId,
        originalFileName: inferredName,
        contentType: "application/pdf",
        sizeBytes: 0,
      });

      // Ask server to fetch the PDF and attach it to this upload.
      const importRes = await fetchWithTempUser(`/api/uploads/${encodeURIComponent(upload.id)}/import-url`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: raw }),
      });
      const importJson = (await importRes.json().catch(() => ({}))) as { error?: unknown };
      if (!importRes.ok) {
        throw new Error(typeof importJson.error === "string" ? importJson.error : "Failed to fetch PDF from link");
      }

      // Trigger processing (async background job).
      await fetchWithTempUser(`/api/uploads/${encodeURIComponent(upload.id)}/process`, { method: "POST" });

      createdDocId = null;
      router.push(`/doc/${encodeURIComponent(docId)}`);
    } catch (e) {
      // The server removes a fileless document itself when the import fails (abandonUpload), so
      // this is for the failures it never sees: the upload row refused, or a request that never
      // reached it. A 404 here means the server got there first.
      if (createdDocId) {
        await fetchWithTempUser(`/api/docs/${encodeURIComponent(createdDocId)}`, { method: "DELETE" }).catch(() => undefined);
      }
      if (e instanceof PlanLimitClientError) {
        openUpgrade("documents", {
          used: e.planLimit.used,
          max: e.planLimit.max ?? undefined,
          graceHint: planLimitGraceHint(e.planLimit),
        });
      } else {
        setError(e instanceof Error ? e.message : "Link upload failed");
      }
    } finally {
      setUrlBusy(false);
    }
  }

  // If something else (e.g. sidebar "Add new file") set a pending file, route to `/upload`.
  useEffect(() => {
    if (onUploadRoute) return;
    if (!pendingFile) return;
    if (lastAutoHandledRef.current === pendingFile) return;
    if (pushingUploadRef.current) return;
    lastAutoHandledRef.current = pendingFile;
    setError(null);
    pushingUploadRef.current = true;
    startUploadNavNow();
    pushUploadRouteSoon();
    window.setTimeout(() => {
      pushingUploadRef.current = false;
    }, 500);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFile, router]);

  const atDocumentLimit = plan?.plan === "free" && plan.atLimit.documents;
  const pickerDisabled = urlBusy || Boolean(atDocumentLimit);
  const freeDocuments =
    plan?.plan === "free" && typeof plan.limits.documents === "number"
      ? { used: plan.usage.documents, max: plan.limits.documents }
      : null;
  // `/api/plan` clears `atLimit` while the launch grace window is open (the server still accepts
  // uploads), so the countdown and the blocked notice are mutually exclusive: the hint can only ever
  // decorate the enabled drop zone and the modal. The snapshot carries the same `grace` shape as a
  // 402 body, and the formatter reads nothing else.
  const graceHint = plan?.plan === "free" && plan.graceActive ? planLimitGraceHint({ grace: plan.grace }) : null;
  const overCapInGrace = Boolean(graceHint) && freeDocuments !== null && freeDocuments.used >= freeDocuments.max;
  const openDocumentUpgrade = () => {
    if (!plan) return;
    openUpgrade("documents", { used: plan.usage.documents, max: plan.limits.documents ?? undefined, graceHint });
  };

  /** Stage a picked or dropped file for the preview route (PDF only). */
  function stageFile(file: File) {
    if (!isPdfFile(file)) {
      setError(PDF_ONLY_MESSAGE);
      return;
    }
    if (atDocumentLimit) {
      openDocumentUpgrade();
      return;
    }
    setPendingFile(file);
    setError(null);
    startUploadNavNow();
    pushUploadRouteSoon();
  }

  const connectedClient = agentStatus?.connected ? (agentStatus.clients[0]?.client ?? agentStatus.lastUsedClient) : null;

  return (
      <div
        className="relative flex h-full min-h-[100svh] flex-col overflow-y-auto bg-[var(--bg)] text-[var(--fg)]"
        // The whole page is a drop target; a depth counter keeps child enter/leave pairs from flickering.
        onDragEnter={(e) => {
          if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
          e.preventDefault();
          dragDepthRef.current += 1;
          setDragActive(true);
        }}
        onDragOver={(e) => {
          if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
          e.preventDefault();
        }}
        onDragLeave={(e) => {
          if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
          dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
          if (dragDepthRef.current === 0) setDragActive(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          dragDepthRef.current = 0;
          setDragActive(false);
          const file = e.dataTransfer?.files?.[0] ?? null;
          if (file) stageFile(file);
        }}
      >
        <AppPageHeader
          icon={DocumentPlusIcon}
          title="Upload"
          description="Turn a PDF into a share link, and see how it is read from the first open."
          actions={
            freeDocuments ? (
              <button
                type="button"
                onClick={openDocumentUpgrade}
                className={[
                  "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[12px] transition-colors",
                  atDocumentLimit || overCapInGrace
                    ? "border-amber-500/40 text-amber-700 hover:bg-amber-500/10 dark:text-amber-300"
                    : "border-[var(--border)] text-[var(--muted-2)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]",
                ].join(" ")}
                title="Free workspaces can share this many documents"
              >
                <span className="tabular-nums">
                  {freeDocuments.used} of {freeDocuments.max} docs
                </span>
                <span aria-hidden="true" className="h-3 w-px bg-current opacity-30" />
                <span className="font-medium">Free</span>
              </button>
            ) : null
          }
        />
        <div className={`mx-auto my-auto w-full max-w-[920px] ${APP_PAGE_GUTTER} pb-16 pt-6`}>
          {/*
            Shown while the workspace is empty, so the first upload retires it with nothing written.
            `plan` is undefined until it loads; `=== 0` rather than `!` keeps the card from flashing
            in before we know, which on a workspace with documents would be a greeting for nobody.
          */}
          <FirstRunWelcome
            show={plan?.usage.documents === 0}
            actions={
              <>
                <UploadButton
                  label="Share your first PDF"
                  accept="pdf"
                  variant="cta"
                  disabled={pickerDisabled}
                  onFileRejected={setError}
                  onFileSelected={stageFile}
                />
                <Link
                  href="/connect"
                  className="inline-flex items-center rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] font-medium text-[var(--fg)] transition-colors hover:bg-[var(--panel-hover)]"
                >
                  Connect an agent
                </Link>
              </>
            }
          />

          {/* Primary action: one large drop zone. */}
          <div
            className={[
              "relative overflow-hidden rounded-2xl border transition-[border-color,background-color,box-shadow] duration-200",
              dragActive && !atDocumentLimit
                ? "border-[var(--feed-new-bar)] bg-[var(--feed-new-bg)] shadow-[0_0_0_4px_var(--feed-new-bg)]"
                : "border-[var(--border)] bg-[var(--panel)]",
            ].join(" ")}
          >
            <div className="flex min-h-[300px] flex-col items-center justify-center px-6 py-12 text-center">
              {atDocumentLimit ? (
                <>
                  <div className="grid h-12 w-12 place-items-center rounded-2xl border border-[var(--border)] bg-[var(--panel-2)]">
                    <LockClosedIcon className="h-5 w-5 text-[var(--muted-2)]" aria-hidden="true" />
                  </div>
                  <div className="mt-5 text-[17px] font-semibold tracking-tight text-[var(--fg)]">
                    All {freeDocuments?.max ?? FREE_PLAN_LIMITS_COPY.documents} Free documents are shared
                  </div>
                  <p className="mt-2 max-w-md text-[13px] leading-6 text-[var(--muted-2)]">
                    Archive a document you no longer need to free a slot, or upgrade to Pro for unlimited documents. Links are never limited: every shared document can carry as many as you need.
                  </p>
                  <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
                    <button
                      type="button"
                      onClick={openDocumentUpgrade}
                      className="inline-flex min-w-[132px] items-center justify-center rounded-lg bg-[var(--primary-bg)] px-5 py-2 text-[13px] font-semibold text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)]"
                    >
                      Upgrade to Pro
                    </button>
                    <Link
                      href="/search?scope=documents"
                      className="inline-flex items-center rounded-lg px-3 py-2 text-[13px] font-medium text-[var(--fg)] hover:bg-[var(--panel-hover)]"
                    >
                      Manage documents
                    </Link>
                  </div>
                </>
              ) : (
                <>
                  <div
                    className={[
                      "grid h-12 w-12 place-items-center rounded-2xl border transition-transform duration-200",
                      dragActive ? "-translate-y-1 border-[var(--feed-new-bar)] bg-[var(--panel)]" : "border-[var(--border)] bg-[var(--panel-2)]",
                    ].join(" ")}
                  >
                    <ArrowUpTrayIcon className="h-5 w-5 text-[var(--fg)]" aria-hidden="true" />
                  </div>
                  <div className="mt-5 text-[17px] font-semibold tracking-tight text-[var(--fg)]">
                    {dragActive ? (
                      "Release to preview"
                    ) : (
                      <>
                        <span className="md:hidden">Upload a PDF</span>
                        <span className="hidden md:inline">Drop a PDF anywhere on this page</span>
                      </>
                    )}
                  </div>
                  <p className="mt-2 text-[13px] text-[var(--muted-2)]">
                    You will see a preview first. Nothing is uploaded until you confirm.
                  </p>
                  {overCapInGrace && freeDocuments ? (
                    <p className="mt-2 text-[13px] text-amber-700 dark:text-amber-300">
                      Over the Free limit of {freeDocuments.max} documents. {graceHint}{" "}
                      <button type="button" onClick={openDocumentUpgrade} className="font-medium underline underline-offset-2 hover:opacity-80">
                        Upgrade to Pro
                      </button>
                    </p>
                  ) : null}
                  <div className="mt-6">
                    <UploadButton
                      label="Choose a PDF"
                      accept="pdf"
                      variant="cta"
                      disabled={pickerDisabled}
                      onFileRejected={setError}
                      onFileSelected={stageFile}
                    />
                  </div>
                </>
              )}
            </div>
            <ul className="flex flex-col items-center gap-1 border-t border-[var(--border)] bg-[var(--panel-2)] px-6 py-3 text-[12px] text-[var(--muted)] md:flex-row md:justify-center md:gap-0 md:py-2.5">
              {["PDF up to 250 MB", "The AI summary uses 1 credit", "Replace the file later and the link stays the same"].map((fact, i) => (
                <li key={fact} className="flex items-center">
                  {i > 0 ? <span aria-hidden="true" className="mx-4 hidden h-3 w-px bg-[var(--border)] md:inline-block" /> : null}
                  {fact}
                </li>
              ))}
            </ul>
          </div>

          {/* Where the document lands (PRD decision 2). Quiet, under the drop zone; hidden when there
              is nothing to choose. Applies to the file and the link paths alike. */}
          <UploadProjectPicker picker={picker} disabled={urlBusy} className="mt-3 justify-end" />

          {error ? (
            <div role="alert" className="mt-4 text-[13px] font-medium text-red-600 dark:text-red-400">
              {error}
            </div>
          ) : null}

          {/* Secondary ways in. */}
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <section className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5">
              <div className="flex items-center gap-2">
                <LinkIcon className="h-4 w-4 text-[var(--muted-2)]" aria-hidden="true" />
                <h2 className="text-[13px] font-semibold text-[var(--fg)]">Import from a link</h2>
              </div>
              <p className="mt-1.5 text-[12px] leading-5 text-[var(--muted)]">
                A public PDF link or a Google Drive share link. We fetch the file and create the share link.
              </p>
              <form
                className="mt-4 flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-1 pl-3 focus-within:border-[var(--muted)]"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (atDocumentLimit) {
                    openDocumentUpgrade();
                    return;
                  }
                  void handleUrlSubmit();
                }}
              >
                <input
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  placeholder="https://example.com/deck.pdf"
                  inputMode="url"
                  aria-label="PDF link"
                  className="min-w-0 flex-1 bg-transparent py-1.5 text-[13px] text-[var(--fg)] placeholder:text-[var(--muted-2)] focus:outline-none"
                  disabled={urlBusy}
                />
                <button
                  type="submit"
                  className={[
                    "inline-flex shrink-0 items-center justify-center rounded-lg px-3.5 py-1.5 text-[13px] font-semibold transition-colors",
                    urlInput.trim() || urlBusy
                      ? "bg-[var(--primary-bg)] text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)] disabled:opacity-70"
                      : "cursor-default bg-[var(--panel-hover)] text-[var(--muted)]",
                  ].join(" ")}
                  disabled={urlBusy || !urlInput.trim()}
                >
                  {urlBusy ? "Fetching…" : "Import"}
                </button>
              </form>

              {/* The one form an MCP tool matches exactly: the same address, the same result. */}
              <AgentHintNotice hintKey="import_url" className="mt-4" />
            </section>

            <section className="flex flex-col rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <CpuChipIcon className="h-4 w-4 text-[var(--muted-2)]" aria-hidden="true" />
                  <h2 className="text-[13px] font-semibold text-[var(--fg)]">Let your agent do it</h2>
                </div>
                <div className="flex items-center gap-1.5 text-[var(--muted-2)]" aria-hidden="true">
                  {["claude-code", "cursor", "codex", "gemini-cli"].map((c) => (
                    <AgentMark key={c} client={c} className="h-3.5 w-3.5" />
                  ))}
                </div>
              </div>
              <p className="mt-1.5 text-[12px] leading-5 text-[var(--muted)]">
                Claude Code, Cursor and other MCP clients can create share links and read their stats for you.
              </p>
              <div className="mt-auto pt-4">
                {connectedClient ? (
                  <Link
                    href="/activity?who=agents"
                    className="inline-flex items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-1.5 text-[13px] font-medium text-[var(--fg)] hover:bg-[var(--panel-hover)]"
                  >
                    <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[var(--chart-views)]" />
                    {agentStatus && agentStatus.connectedCount > 1 ? `${agentStatus.connectedCount} agents connected` : "Agent connected"}
                    <span className="text-[var(--muted)]">· See activity</span>
                  </Link>
                ) : (
                  <Link
                    href="/connect"
                    className="inline-flex items-center rounded-lg border border-[var(--border)] px-3 py-1.5 text-[13px] font-medium text-[var(--fg)] hover:bg-[var(--panel-hover)]"
                  >
                    Connect an agent
                  </Link>
                )}
              </div>
            </section>
          </div>
        </div>
      </div>
  );
}


