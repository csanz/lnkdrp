/**
 * The gate on the admin area.
 *
 * Every endpoint under `/api/admin/*` calls `requireAdmin`, so no admin *data* has
 * ever been reachable without the role. The pages were a different matter: this file was a client
 * component, it gated nothing, and the twenty-two pages under it are all client components that
 * fetch those endpoints. So a signed-out visitor who typed `/a` got the admin chrome, a sidebar
 * naming every section, and panels that failed to load.
 *
 * Nothing leaked except the shape of the admin surface, which is still more than a stranger should
 * be handed, and the dead end read as a broken page rather than a closed door.
 *
 * `notFound()` rather than a redirect, and the same answer for "not signed in", "signed in but not
 * an admin" and "an API key": the admin area does not confirm it exists to anyone who is not in it.
 * That is the rule `/api/debug` already follows.
 *
 * The check runs on every navigation inside `/a` because a layout re-renders per request in the App
 * Router. It costs one cached actor resolve and one `_id`-keyed user read, which is what the
 * endpoints underneath were each going to do anyway.
 */
import { headers } from "next/headers";
import { notFound } from "next/navigation";

import AdminShell from "@/components/admin/AdminShell";
import { requireAdmin } from "@/lib/gating/requireAdmin";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // `requireAdmin` reads the session off a `Request`; a layout has the incoming headers instead, and
  // they carry the cookie it needs. Building one here keeps a single implementation of the rule
  // rather than a second copy that answers "is this an admin" slightly differently — which is the
  // exact drift the helper was written to end (it replaced twenty-six copies).
  const gate = await requireAdmin(new Request("https://lnkdrp.internal/a", { headers: await headers() }));
  if (!gate.ok) notFound();

  return <AdminShell>{children}</AdminShell>;
}
