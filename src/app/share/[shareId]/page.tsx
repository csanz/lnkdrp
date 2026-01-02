/**
 * Route: `/share/:shareId` — legacy recipient-facing share link. Redirects to `/s/:shareId`.
 */
import { redirect } from "next/navigation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function ShareRedirect(props: {
  params: Promise<{ shareId: string }>;
}) {
  const { shareId } = await props.params;
  redirect(`/s/${encodeURIComponent(shareId)}`);
}
