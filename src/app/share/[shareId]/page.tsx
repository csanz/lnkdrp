import { redirect } from "next/navigation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Legacy route: `/share/:shareId` → `/s/:shareId`
 *
 * Keep this as a redirect so older links continue to work.
 */
export default async function ShareRedirect(props: { params: Promise<{ shareId: string }> }) {
  const { shareId } = await props.params;
  redirect(`/s/${encodeURIComponent(shareId)}`);
}

