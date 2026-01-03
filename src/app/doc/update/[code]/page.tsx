/**
 * Public doc update page (upload a new version for an existing doc).
 * Route: `/doc/update/:code`
 */
import DocUpdatePageClient from "./pageClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function DocUpdatePage(props: { params: Promise<{ code: string }> }) {
  const { code } = await props.params;
  const updateCode = decodeURIComponent(code || "").trim();

  return <DocUpdatePageClient code={updateCode} />;
}


