/**
 * Route: `/p/:shareId` — the recipient-facing project page (the data room's front door).
 *
 * This used to be a placeholder that looked up `Project.shareId` directly and linked each card at
 * `/s/<the document's own slug>`, which meant a recipient left the project link the moment they
 * opened anything: the reading, the sessions and the downloads all landed under the document's
 * default link, and the sender could never tell which audience did them. That is the attribution
 * hole docs/prds/lnkdrp-project-links.md exists to close.
 *
 * Now the slug resolves a **project `ShareLink`** (`resolveProjectLink`, which materialises the
 * default link from `Project.shareId` on first visit, so no URL in anyone's inbox stops working),
 * enforces enabled/expiry/password with the same share-auth cookie documents use, and links each
 * card at `/p/:shareId/:docId` so the whole visit stays on one link.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";

import BrandHeader from "@/components/BrandHeader";
import PasswordGate from "@/components/PasswordGate";
import { shareAuthCookieName, shareAuthCookieValue } from "@/lib/sharePassword";
import { resolveProjectLink } from "@/lib/share/projectLinks";
import { listProjectDocuments, projectLinkPasswordEnabled, type PublicProjectDoc } from "@/lib/share/projectPublic";
import { buildShareMetadata } from "@/lib/share/shareMetadata";

import LandingBeacon from "./LandingBeacon";
import RefusalNotice from "./RefusalNotice";
import { PROJECT_SHARE_THEME } from "./shareTheme";

function pickDocTitle(doc: PublicProjectDoc): string {
  const title = typeof doc.title === "string" ? doc.title.trim() : "";
  if (title) return title;
  const docName = typeof doc.docName === "string" ? doc.docName.trim() : "";
  if (docName) return docName;
  const fileName = typeof doc.fileName === "string" ? doc.fileName.trim() : "";
  if (fileName) return fileName;
  return "Untitled document";
}

function pickDocPreviewUrl(doc: PublicProjectDoc): string | null {
  const a = typeof doc.previewImageUrl === "string" ? doc.previewImageUrl.trim() : "";
  if (a) return a;
  const b = typeof doc.firstPagePngUrl === "string" ? doc.firstPagePngUrl.trim() : "";
  if (b) return b;
  return null;
}

type OgLike = { description?: unknown };

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

/**
 * The data room's own link card: the project's name, and its description when it has one.
 *
 * Locked or refused → the generic card, the same rule `/s/:shareId` follows and the same one the
 * password gate below already applies to the rendered page ("not the project's name, not how many
 * documents are in it"). No document thumbnail ever: a project link points at a list, and the first
 * file in that list is not the thing being shared.
 */
export async function generateMetadata(props: { params: Promise<{ shareId: string }> }): Promise<Metadata> {
  const { shareId } = await props.params;
  if (!shareId) return buildShareMetadata({ title: "Shared documents", description: "" });

  const resolved = await resolveProjectLink(shareId, { select: { description: 1 } });
  if (!resolved || resolved.refusal || projectLinkPasswordEnabled(resolved.link)) {
    return buildShareMetadata({ title: "Shared documents", description: "" });
  }
  const { project } = resolved;
  const name = typeof project.name === "string" ? project.name.trim() : "";
  const description = typeof project.description === "string" ? project.description.trim() : "";
  return buildShareMetadata({ title: name || "Shared documents", description: description ? truncate(description) : "" });
}

export default async function PublicProjectSharePage(props: { params: Promise<{ shareId: string }> }) {
  const { shareId } = await props.params;
  if (!shareId) notFound();

  const resolved = await resolveProjectLink(shareId, { select: { description: 1 } });
  // An unknown slug, a document link's slug, or a deleted project: indistinguishable, on purpose.
  if (!resolved || resolved.refusal === "project_gone") notFound();
  const { link, project } = resolved;
  // Expiry is the one refusal a recipient can act on, so it gets its own words (see RefusalNotice);
  // a disabled or archived link reads exactly as it did before this feature existed.
  if (resolved.refusal) return <RefusalNotice kind={resolved.refusal === "expired" ? "expired" : "disabled"} />;

  if (projectLinkPasswordEnabled(link)) {
    const c = await cookies();
    const cookie = c.get(shareAuthCookieName(shareId))?.value ?? "";
    const expected = shareAuthCookieValue({ shareId, sharePasswordHash: link.passwordHash as string });
    if (!cookie || cookie !== expected) {
      // Nothing before the password — not the project's name, not how many documents are in it.
      // Same rule as the document gate: the sender chose a password because the URL is not the
      // secret, and "Acme — Series A data room · 11 documents" gives away most of the answer.
      return <PasswordGate shareId={shareId} title={null} previewUrl={null} />;
    }
  }

  // Resolved per request (PRD open question, "contents follow the project"): a document taken out
  // of the project stops being listed — and stops being openable — on the very next load.
  const docs = await listProjectDocuments(project);
  const name = typeof project.name === "string" ? project.name : "";
  const description = typeof project.description === "string" ? project.description : "";

  return (
    <main className="min-h-screen bg-[var(--bg)] text-[var(--fg)]" style={PROJECT_SHARE_THEME}>
      <BrandHeader />
      <LandingBeacon shareId={shareId} />
      <div className="mx-auto w-full max-w-5xl px-6 pb-12 pt-6">
        <div className="text-2xl font-semibold tracking-tight text-[var(--fg)]">{name}</div>
        {description ? <div className="mt-2 max-w-3xl text-sm leading-relaxed text-[var(--muted)]">{description}</div> : null}

        <div className="mt-8 flex items-baseline justify-between gap-3">
          <div className="text-sm font-semibold text-[var(--fg)]">Documents</div>
          <div className="text-xs text-[var(--muted-2)]">{docs.length} total</div>
        </div>

        {docs.length ? (
          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {docs.map((d) => {
              const docId = String(d._id);
              const title = pickDocTitle(d);
              const previewUrl = pickDocPreviewUrl(d);
              const summary = pickDocSummary(d.aiOutput ?? null);

              return (
                <Link
                  key={docId}
                  // The document opens *under this link*, never at `/s/<its own slug>`: that is what
                  // makes the reading time, the session and any download attributable to the
                  // audience this link was sent to.
                  href={`/p/${encodeURIComponent(shareId)}/${encodeURIComponent(docId)}`}
                  className="group overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)] shadow-sm transition-colors hover:bg-[var(--panel-hover)]"
                  aria-label={`Open shared document: ${title}`}
                >
                  <div className="relative aspect-[16/10] w-full bg-[var(--panel-2)]">
                    {previewUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={previewUrl}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        className="h-full w-full object-contain transition-transform duration-200 group-hover:scale-[1.01]"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-xs font-medium text-[var(--muted-2)]">
                        No preview
                      </div>
                    )}
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
