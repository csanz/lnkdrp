"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import UploadButton from "@/components/UploadButton";
import AppShellLayout from "./(app)/AppShellLayout";
import { apiCreateDoc, apiCreateUpload } from "@/lib/client/docUploadPipeline";
import { usePendingUpload } from "@/lib/pendingUpload";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import { fetchJson } from "@/lib/http/fetchJson";
import { switchWorkspaceWithOverlay } from "@/components/SwitchingOverlay";
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
 * Render the HomeAuthedClient UI (uses effects, memoized values, local state).
 */


export default function HomeAuthedClient() {
  const router = useRouter();
  const { pendingFile, setPendingFile, setHasEnteredShell } = usePendingUpload();
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const lastAutoHandledRef = useRef<File | null>(null);
  const [urlInput, setUrlInput] = useState("");
  const [urlBusy, setUrlBusy] = useState(false);
  const pushingUploadRef = useRef(false);

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
    try {
      // Ensure the "Fetching…" UI renders immediately before we do any async work.
      await waitForNextPaint();
      await ensureOrgReadyForUpload();
      const inferredName = fileNameFromUrl(raw);
      // For URL uploads, don't name the doc from the URL path (e.g. ".../view" → "view").
      // Start with a neutral placeholder; the processing pipeline will rename using AI `docName`.
      const docId = await apiCreateDoc({ title: "Untitled document" });
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

      router.push(`/doc/${encodeURIComponent(docId)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Link upload failed");
    } finally {
      setUrlBusy(false);
    }
  }

  // If something else (e.g. sidebar "Add new file") set a pending file, route to `/upload`.
  useEffect(() => {
    if (!pendingFile) return;
    if (lastAutoHandledRef.current === pendingFile) return;
    if (pushingUploadRef.current) return;
    lastAutoHandledRef.current = pendingFile;
    setError(null);
    pushingUploadRef.current = true;
    router.push("/upload");
    window.setTimeout(() => {
      pushingUploadRef.current = false;
    }, 500);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFile, router]);

  return (
    <AppShellLayout>
      <div className="h-full min-h-[100svh] bg-[var(--bg)] text-[var(--fg)]">
        <div className="flex h-full min-h-[100svh] w-full items-center justify-center px-6 py-10">
          <div className="w-full max-w-3xl">
            <div
              className={[
                "relative rounded-3xl border border-dashed p-10 text-center",
                "bg-[var(--panel)]",
                dragActive
                  ? "border-[var(--ring)] ring-2 ring-[var(--ring)]"
                  : "border-[var(--border)]",
              ].join(" ")}
              onDragEnter={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDragActive(true);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDragActive(true);
              }}
              onDragLeave={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDragActive(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDragActive(false);
                const file = e.dataTransfer?.files?.[0] ?? null;
                if (!file) return;
                const name = (file.name ?? "").toLowerCase();
                const isPdf = file.type === "application/pdf" || name.endsWith(".pdf");
                if (!isPdf) return;
                setPendingFile(file);
                setError(null);
                router.push("/upload");
              }}
            >
              <div className="text-xl font-semibold tracking-tight">Upload</div>
              <div className="mt-3 text-sm leading-6 text-[var(--muted)]">Choose a PDF to preview, then upload.</div>

              <div className="mt-8 flex flex-col items-center gap-3.5">
                <UploadButton
                  label="Choose a PDF"
                  accept="pdf"
                  variant="cta"
                  disabled={urlBusy}
                  onFileSelected={(file) => {
                    setPendingFile(file);
                    setError(null);
                    router.push("/upload");
                  }}
                />
                <div className="text-xs leading-5 text-[var(--muted)]">
                  or drag and drop a PDF anywhere onto this area
                </div>
              </div>

                <div className="mt-8 flex items-center gap-3">
                  <div className="h-px flex-1 bg-[var(--border)]" />
                  <div className="text-xs font-medium text-[var(--muted)]">or</div>
                  <div className="h-px flex-1 bg-[var(--border)]" />
                </div>

                <div className="mt-6">
                  <div className="text-sm font-semibold text-[var(--fg)]">Paste a PDF link</div>
                  <div className="mt-2 text-xs leading-5 text-[var(--muted)]">
                    We’ll download it and create a share link for you.
                  </div>
                  <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
                    <input
                      value={urlInput}
                      onChange={(e) => setUrlInput(e.target.value)}
                      placeholder="https://example.com/pitch.pdf"
                      className="w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--fg)] placeholder:text-[var(--muted)] focus:outline-none focus:ring-2 focus:ring-black/10"
                    disabled={urlBusy}
                      onKeyDown={(e) => {
                        if (e.key !== "Enter") return;
                        e.preventDefault();
                        void handleUrlSubmit();
                      }}
                    />
                    <button
                      type="button"
                      className="inline-flex shrink-0 items-center justify-center rounded-xl bg-[var(--primary-bg)] px-4 py-2 text-sm font-semibold text-[var(--primary-fg)] transition-colors hover:bg-[var(--primary-hover-bg)] disabled:opacity-60"
                      onClick={() => void handleUrlSubmit()}
                    disabled={urlBusy}
                    >
                      {urlBusy ? "Fetching…" : "Upload link"}
                    </button>
                  </div>
                </div>

                {error ? <div className="mt-5 text-sm font-medium text-red-600">{error}</div> : null}
            </div>
          </div>
        </div>
      </div>
    </AppShellLayout>
  );
}


