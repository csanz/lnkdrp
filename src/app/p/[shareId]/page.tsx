/**
 * Public project share page for `/p/:shareId`.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LockClosedIcon } from "@heroicons/react/24/solid";
import { connectMongo } from "@/lib/mongodb";
import { ProjectModel } from "@/lib/models/Project";
import { DocModel } from "@/lib/models/Doc";

type PublicDocListItem = {
  shareId?: unknown;
  title?: unknown;
  docName?: unknown;
  fileName?: unknown;
  previewImageUrl?: unknown;
  firstPagePngUrl?: unknown;
  sharePasswordHash?: unknown;
  aiOutput?: unknown;
};

function pickDocTitle(doc: PublicDocListItem): string {
  const title = typeof doc.title === "string" ? doc.title.trim() : "";
  if (title) return title;
  const docName = typeof doc.docName === "string" ? doc.docName.trim() : "";
  if (docName) return docName;
  const fileName = typeof doc.fileName === "string" ? doc.fileName.trim() : "";
  if (fileName) return fileName;
  return "Untitled document";
}

function pickDocPreviewUrl(doc: PublicDocListItem): string | null {
  const a = typeof doc.previewImageUrl === "string" ? doc.previewImageUrl.trim() : "";
  if (a) return a;
  const b = typeof doc.firstPagePngUrl === "string" ? doc.firstPagePngUrl.trim() : "";
  if (b) return b;
  return null;
}

type OgLike = {
  description?: unknown;
};

function pickDocSummary(aiOutput: unknown): string | null {
  if (!aiOutput || typeof aiOutput !== "object") return null;
  const ai = aiOutput as Record<string, unknown>;
  const oneLiner = typeof ai.one_liner === "string" ? ai.one_liner.trim() : "";
  if (oneLiner) return oneLiner;
  const summary = typeof ai.summary === "string" ? ai.summary.trim() : "";
  if (summary) return summary;
  const metaDesc = typeof ai.meta_description === "string" ? ai.meta_description.trim() : "";
  if (metaDesc) return metaDesc;
  const og = (ai as { openGraph?: OgLike }).openGraph;
  const ogDesc = og && typeof og === "object" && typeof og.description === "string" ? og.description.trim() : "";
  if (ogDesc) return ogDesc;
  return null;
}

function isPasswordProtected(doc: PublicDocListItem): boolean {
  const raw = doc.sharePasswordHash;
  return typeof raw === "string" && raw.trim().length > 0;
}

function truncate(s: string, max = 220): string {
  const t = s.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

export default async function PublicProjectSharePlaceholderPage(props: {
  params: Promise<{ shareId: string }>;
}) {
  const { shareId } = await props.params;
  if (!shareId) notFound();

  await connectMongo();
  const project = await ProjectModel.findOne({ shareId, isDeleted: { $ne: true } })
    .select({ _id: 1, name: 1, description: 1, orgId: 1 })
    .lean();
  if (!project) notFound();

  const docs = await DocModel.find({
    ...((project as any).orgId ? { orgId: (project as any).orgId } : null),
    isDeleted: { $ne: true },
    isArchived: { $ne: true },
    $or: [{ projectId: project._id }, { projectIds: project._id }],
  })
    .select({
      shareId: 1,
      title: 1,
      docName: 1,
      fileName: 1,
      previewImageUrl: 1,
      firstPagePngUrl: 1,
      sharePasswordHash: 1,
      "aiOutput.one_liner": 1,
      "aiOutput.summary": 1,
      "aiOutput.meta_description": 1,
      "aiOutput.openGraph.description": 1,
      updatedDate: 1,
      createdDate: 1,
    })
    .sort({ updatedDate: -1, createdDate: -1 })
    .lean();

  return (
    <main
      className="min-h-screen bg-[var(--bg)] text-[var(--fg)]"
      style={
        {
          // Force dark theme for share links (do not depend on user theme).
          colorScheme: "dark",
          ["--bg" as any]: "#0b0b0c",
          ["--fg" as any]: "#e7e7ea",
          ["--panel" as any]: "#111113",
          ["--panel-2" as any]: "#151518",
          ["--panel-hover" as any]: "#1b1b1f",
          ["--border" as any]: "#2a2a31",
          ["--muted" as any]: "#b3b3bb",
          ["--muted-2" as any]: "#8b8b96",
        } as React.CSSProperties
      }
    >
      <header className="sticky top-0 z-20 w-full border-b border-white/10 bg-black/85 text-white/90 backdrop-blur-sm">
        <div className="px-4 py-3 sm:px-6">
          <div className="flex items-center justify-between gap-4">
            {/* Left (match `/s/:shareId` header dimensions, but show only the logo) */}
            <div className="flex min-w-0 items-center gap-3">
              <div aria-hidden="true" className="inline-flex items-center justify-center">
                <Image src="/icon-white.svg?v=3" alt="" width={26} height={26} priority />
              </div>

              {/* Height shim: match `/s/:shareId` header height (includes border + padding from the controls pill). */}
              <div
                aria-hidden="true"
                className="invisible inline-flex items-center rounded-2xl border border-white/10 bg-white/5 p-1.5"
              >
                <div className="h-8 w-px" />
              </div>
            </div>
          </div>
        </div>
      </header>
      <div className="mx-auto w-full max-w-5xl px-6 pb-12 pt-6">
        <div className="text-2xl font-semibold tracking-tight text-[var(--fg)]">{(project as any).name}</div>
        {(project as any).description ? (
          <div className="mt-2 max-w-3xl text-sm leading-relaxed text-[var(--muted)]">
            {(project as any).description}
          </div>
        ) : null}

        <div className="mt-8 flex items-baseline justify-between gap-3">
          <div className="text-sm font-semibold text-[var(--fg)]">Documents</div>
          <div className="text-xs text-[var(--muted-2)]">{docs.length} total</div>
        </div>

        {docs.length ? (
          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {docs.map((d) => {
              const share = typeof (d as { shareId?: unknown }).shareId === "string" ? String(d.shareId) : "";
              if (!share) return null;
              const title = pickDocTitle(d as unknown as PublicDocListItem);
              const previewUrl = pickDocPreviewUrl(d as unknown as PublicDocListItem);
              const summary = pickDocSummary((d as { aiOutput?: unknown }).aiOutput ?? null);
              const locked = isPasswordProtected(d as unknown as PublicDocListItem);

              return (
                <Link
                  key={share}
                  href={`/s/${encodeURIComponent(share)}`}
                  className="group overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)] shadow-sm transition-colors hover:bg-[var(--panel-hover)]"
                  aria-label={`${locked ? "Password protected: " : ""}Open shared document: ${title}`}
                >
                  <div className="relative aspect-[16/10] w-full bg-[var(--panel-2)]">
                    {previewUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={previewUrl}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        className={[
                          "h-full w-full object-contain transition-transform duration-200 group-hover:scale-[1.01]",
                          locked ? "opacity-70" : "opacity-100",
                        ].join(" ")}
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-xs font-medium text-[var(--muted-2)]">
                        No preview
                      </div>
                    )}

                    {locked ? (
                      <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[rgba(17,17,19,0.85)] px-2 py-1 text-[11px] font-semibold text-[var(--fg)]">
                        <LockClosedIcon className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Password</span>
                      </div>
                    ) : null}
                  </div>

                  <div className="px-4 py-4">
                    <div className="text-sm font-semibold leading-snug text-[var(--fg)]">{title}</div>
                    {summary ? (
                      <div className="mt-2 text-sm leading-relaxed text-[var(--muted)]">{truncate(summary)}</div>
                    ) : (
                      <div className="mt-2 text-sm text-[var(--muted-2)]">Open to view details.</div>
                    )}
                    <div className="mt-3 text-xs font-medium text-[var(--muted-2)] group-hover:text-[var(--fg)]">
                      Open shared document →
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        ) : (
          <div className="mt-4 rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4 text-sm text-[var(--muted)]">
            No documents found in this project.
          </div>
        )}
      </div>
    </main>
  );
}


