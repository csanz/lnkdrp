export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * Public project share page for `/p/:shareId`.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
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
  const project = await ProjectModel.findOne({ shareId, isDeleted: { $ne: true } }).lean();
  if (!project) notFound();

  const docs = await DocModel.find({
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
      aiOutput: 1,
      updatedDate: 1,
      createdDate: 1,
    })
    .sort({ updatedDate: -1, createdDate: -1 })
    .lean();

  return (
    <main className="min-h-screen bg-white text-zinc-900">
      <div className="mx-auto w-full max-w-5xl px-6 py-10">
        <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">Shared project</div>
        <div className="mt-2 text-2xl font-semibold tracking-tight">{project.name}</div>
        {project.description ? (
          <div className="mt-2 max-w-3xl text-sm leading-relaxed text-zinc-600">{project.description}</div>
        ) : null}

        <div className="mt-8 flex items-baseline justify-between gap-3">
          <div className="text-sm font-semibold text-zinc-900">Documents</div>
          <div className="text-xs text-zinc-500">{docs.length} total</div>
        </div>

        {docs.length ? (
          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {docs.map((d) => {
              const share = typeof (d as { shareId?: unknown }).shareId === "string" ? String(d.shareId) : "";
              if (!share) return null;
              const title = pickDocTitle(d as unknown as PublicDocListItem);
              const previewUrl = pickDocPreviewUrl(d as unknown as PublicDocListItem);
              const summary = pickDocSummary((d as { aiOutput?: unknown }).aiOutput ?? null);

              return (
                <Link
                  key={share}
                  href={`/s/${encodeURIComponent(share)}`}
                  className="group overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm transition-colors hover:border-zinc-300 hover:bg-zinc-50"
                  aria-label={`Open shared document: ${title}`}
                >
                  <div className="aspect-[4/3] w-full bg-zinc-100">
                    {previewUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={previewUrl}
                        alt=""
                        className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-xs font-medium text-zinc-500">
                        No preview
                      </div>
                    )}
                  </div>
                  <div className="px-4 py-4">
                    <div className="text-sm font-semibold leading-snug text-zinc-900">{title}</div>
                    {summary ? (
                      <div className="mt-2 text-sm leading-relaxed text-zinc-600">{truncate(summary)}</div>
                    ) : (
                      <div className="mt-2 text-sm text-zinc-500">Open to view details.</div>
                    )}
                    <div className="mt-3 text-xs font-medium text-zinc-600 group-hover:text-zinc-800">
                      Open shared document →
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        ) : (
          <div className="mt-4 rounded-2xl border border-zinc-200 bg-white px-5 py-4 text-sm text-zinc-600">
            No documents found in this project.
          </div>
        )}
      </div>
    </main>
  );
}


