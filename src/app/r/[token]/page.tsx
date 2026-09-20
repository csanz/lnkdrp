import { notFound } from "next/navigation";
import { connectMongo } from "@/lib/mongodb";
import { ProjectModel } from "@/lib/models/Project";
import RequestUploadPageClient from "./pageClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * Render the RequestUploadPage UI.
 */


export default async function RequestUploadPage(props: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await props.params;
  const requestToken = decodeURIComponent(token || "").trim();
  if (!requestToken) notFound();

  await connectMongo();
  // `isDeleted` belongs in the lookup, not just in the owner's own lists. Deleting the request repo
  // is the only thing an owner could do about a forwarded upload link before rotation existed, and
  // it did nothing: this query matched on the token alone, so a retired repo kept serving its
  // upload page and kept accepting files. The view-token readers under src/app/request-view carry
  // the same clause; so does `/api/requests/:token/uploads`, which is the API half of this page —
  // the two must stay in step or the page refuses while the endpoint still writes.
  const project = await ProjectModel.findOne({
    requestUploadToken: requestToken,
    isDeleted: { $ne: true },
  })
    .select({ _id: 1, name: 1, description: 1, isRequest: 1, requestRequireAuthToUpload: 1 })
    .lean();

  if (!project) notFound();

  // Best-effort backfill: older rows may have `requestUploadToken` but missing/false `isRequest`.
  // (Mongoose schema hooks do not run for raw update operations.)
  try {
    const persistedIsRequest = Boolean((project as unknown as { isRequest?: unknown }).isRequest);
    if (!persistedIsRequest) {
      await ProjectModel.updateOne(
        { _id: project._id, requestUploadToken: requestToken },
        { $set: { isRequest: true } },
      );
    }
  } catch {
    // ignore; request token itself is the capability, so allowing the link is still correct
  }

  return (
    <RequestUploadPageClient
      token={requestToken}
      requestName={typeof project.name === "string" ? project.name : ""}
      requestDescription={typeof project.description === "string" ? project.description : ""}
      requireAuthToUpload={Boolean(
        (project as unknown as { requestRequireAuthToUpload?: unknown }).requestRequireAuthToUpload,
      )}
    />
  );
}


