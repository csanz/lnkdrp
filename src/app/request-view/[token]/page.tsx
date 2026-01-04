/**
 * Public request-repo viewer: `/request-view/:token`.
 *
 * This is a view-only capability link that allows recipients to view documents
 * within a request repository without granting upload access.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { connectMongo } from "@/lib/mongodb";
import { ProjectModel } from "@/lib/models/Project";
import { DocModel } from "@/lib/models/Doc";
import { StandaloneBrandedHeader } from "@/components/StandaloneBrandedHeader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function RequestViewPage(props: { params: Promise<{ token: string }> }) {
  const { token } = await props.params;
  const viewToken = decodeURIComponent(token || "").trim();
  if (!viewToken) notFound();

  await connectMongo();
  const project = await ProjectModel.findOne({ requestViewToken: viewToken })
    .select({ _id: 1, name: 1, description: 1, isRequest: 1 })
    .lean();
  if (!project) notFound();

  const docs = await DocModel.find({
    receivedViaRequestProjectId: project._id,
    isDeleted: { $ne: true },
  })
    .sort({ updatedDate: -1 })
    .select({ _id: 1, title: 1, fileName: 1, status: 1, createdDate: 1, updatedDate: 1 })
    .lean();

  const title = typeof project.name === "string" && project.name.trim() ? project.name.trim() : "Request repository";
  const description =
    typeof project.description === "string" && project.description.trim() ? project.description.trim() : "";

  return (
    <main className="min-h-screen bg-[var(--bg)] text-[var(--fg)]">
      <StandaloneBrandedHeader kicker="Request repository" />
      <div className="mx-auto w-full max-w-3xl px-4 py-10">
      <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">Request repository</div>
      <h1 className="mt-2 text-2xl font-semibold text-[var(--fg)]">{title}</h1>
      {description ? <div className="mt-2 text-sm text-[var(--muted)]">{description}</div> : null}

      <div className="mt-6 flex items-center justify-between gap-3">
        <div className="text-sm text-[var(--muted)]">
          {docs.length} {docs.length === 1 ? "document" : "documents"}
        </div>
      </div>

      <div className="mt-4 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)]">
        {docs.length ? (
          <ul className="divide-y divide-[var(--border)]">
            {docs.map((d) => {
              const docId = String((d as { _id?: unknown })._id ?? "");
              const rawTitle = (d as { title?: unknown }).title;
              const rawFileName = (d as { fileName?: unknown }).fileName;
              const displayTitle =
                (typeof rawTitle === "string" && rawTitle.trim()) ||
                (typeof rawFileName === "string" && rawFileName.trim()) ||
                "Untitled";
              const statusRaw = (d as { status?: unknown }).status;
              const status = typeof statusRaw === "string" ? statusRaw : "";
              const ready = status.toLowerCase() === "ready";
              const pdfHref = `/api/request-view/${encodeURIComponent(viewToken)}/docs/${encodeURIComponent(docId)}/pdf`;

              return (
                <li key={docId} className="flex items-center justify-between gap-4 px-4 py-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-[var(--fg)]">{displayTitle}</div>
                    <div className="mt-0.5 text-xs text-[var(--muted)]">
                      Status:{" "}
                      <span className="font-semibold text-[var(--fg)]">{status || "unknown"}</span>
                    </div>
                  </div>

                  {ready ? (
                    <Link
                      href={pdfHref}
                      target="_blank"
                      rel="noreferrer"
                      className="shrink-0 rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)]"
                    >
                      Open PDF
                    </Link>
                  ) : (
                    <span className="shrink-0 rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] font-semibold text-[var(--muted)] opacity-60">
                      Preparing…
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="px-4 py-10 text-center text-sm text-[var(--muted)]">No documents yet.</div>
        )}
      </div>
      </div>
    </main>
  );
}




