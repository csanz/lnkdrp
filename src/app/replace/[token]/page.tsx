/**
 * Public doc replacement upload page.
 * Route: `/replace/:token`
 */
import DocUpdatePage from "@/app/doc/update/[code]/page";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function ReplaceUploadPage(props: { params: Promise<{ token: string }> }) {
  const { token } = await props.params;
  return await DocUpdatePage({ params: Promise.resolve({ code: token }) });
}


