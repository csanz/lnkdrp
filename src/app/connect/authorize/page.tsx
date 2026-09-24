/**
 * `/connect/authorize` — the consent screen an agent sends its person to.
 *
 * The OAuth authorization endpoint (`src/lib/agents/oauth.ts`). An MCP client opens this in the
 * browser with its `client_id`, `redirect_uri`, PKCE challenge and `state`; the person signs in
 * if they are not, picks the workspace the agent will act in, and clicks Allow. The form posts to
 * `/api/oauth/authorize`, which mints the code and redirects back to the client.
 *
 * Outside the `(app)` group on purpose: this is a one-question page a person sees for ten
 * seconds, on the public dark frame, not the app shell with a sidebar. A bad client or a bad
 * redirect renders an error here and never redirects; anything else that is wrong is sent to the
 * client as an OAuth error, which is how it expects to hear it.
 */
import type { Metadata } from "next";
import { getServerSession } from "next-auth";
import Link from "next/link";
import { redirect } from "next/navigation";

import PublicGuideShell from "@/components/connect/PublicGuideShell";
import { authOptions } from "@/lib/auth";
import { AUTHORIZE_PARAM_NAMES, authorizeParamsFrom, redirectWith, validateAuthorizeRequest, workspacesForUser } from "@/lib/agents/oauthAuthorize";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Connect an agent · lnkdrp",
  robots: { index: false, follow: false },
};

const SCOPE_COPY: Record<"read" | "write", string> = {
  read: "Read your documents, share links, projects and analytics",
  write: "Upload and replace PDFs, create and change share links, archive and delete documents",
};

const PRIMARY =
  "inline-flex h-10 items-center justify-center rounded-xl bg-white px-5 text-[13px] font-semibold text-black transition-colors hover:bg-white/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40 motion-reduce:transition-none";
const QUIET =
  "inline-flex h-10 items-center justify-center rounded-xl border border-white/15 px-4 text-[13px] font-medium text-white/70 transition-colors hover:bg-white/[0.06] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/30 motion-reduce:transition-none";

function ErrorScreen({ title, detail }: { title: string; detail: string }) {
  return (
    <PublicGuideShell>
      <p className="mb-4 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/55">Connect an agent</p>
      <h1 className="font-serif text-4xl leading-[1.05] tracking-tight text-white">{title}</h1>
      <p className="mt-5 max-w-xl text-sm leading-6 text-white/60 sm:text-base">{detail}</p>
      <p className="mt-8 text-sm text-white/60">
        Prefer a key?{" "}
        <Link href="/connect" className="font-medium text-white underline-offset-4 hover:underline">
          Create one on the Connect page
        </Link>
        .
      </p>
    </PublicGuideShell>
  );
}

export default async function AuthorizePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams;
  const params = authorizeParamsFrom(raw);

  const validation = await validateAuthorizeRequest(params);
  if (validation.kind === "page_error") return <ErrorScreen title={validation.title} detail={validation.detail} />;
  if (validation.kind === "redirect_error") {
    redirect(redirectWith(validation.redirectUri, { error: validation.error, error_description: validation.description, state: validation.state }));
  }

  const session = await getServerSession(authOptions);
  const userId = session?.user?.id;
  if (!userId) {
    // Back here, with the same request, once signed in. Re-encoded so `next` is one clean path.
    const qs = new URLSearchParams();
    for (const k of AUTHORIZE_PARAM_NAMES) if (params[k]) qs.set(k, params[k] as string);
    redirect(`/login?next=${encodeURIComponent(`/connect/authorize?${qs.toString()}`)}`);
  }

  const workspaces = await workspacesForUser(userId);
  const { client, scopes } = validation;
  const wantsWrite = scopes.includes("write");
  const who = session?.user?.email ?? session?.user?.name ?? "you";

  return (
    <PublicGuideShell>
      <p className="mb-4 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/55">Connect an agent</p>
      <h1 className="font-serif text-4xl leading-[1.05] tracking-tight text-white sm:text-5xl">
        Let {client.clientName} use lnkdrp?
      </h1>
      <p className="mt-5 max-w-xl text-sm leading-6 text-white/60 sm:text-base">
        {client.clientName} is asking to act in one of your workspaces. It will do only what you can do there, and you can disconnect
        it at any time from the Connect page.
      </p>

      <form method="post" action="/api/oauth/authorize" className="mt-10 max-w-xl">
        {AUTHORIZE_PARAM_NAMES.map((k) => (params[k] ? <input key={k} type="hidden" name={k} value={params[k]} /> : null))}

        <fieldset className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <legend className="px-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-white/55">Workspace</legend>
          {workspaces.length === 0 ? (
            <p className="text-sm text-white/60">You are not a member of any workspace yet. Sign in to the app once, then try again.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {workspaces.map((w, i) => {
                const readOnly = wantsWrite && !w.allowedScopes.includes("write");
                return (
                  <li key={w.id}>
                    <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-white/10 px-4 py-3 transition-colors hover:border-white/20 hover:bg-white/[0.04] has-[:checked]:border-white/40 has-[:checked]:bg-white/[0.06] motion-reduce:transition-none">
                      <input type="radio" name="org_id" value={w.id} defaultChecked={i === 0} className="mt-1 h-4 w-4 accent-white" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[14px] font-medium text-white">{w.name}</span>
                        <span className="mt-0.5 block text-[12px] text-white/50">
                          {`You are ${w.role}`}
                          {readOnly ? " · read only for your role" : ""}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </fieldset>

        <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/55">{client.clientName} will be able to</p>
          <ul className="mt-3 flex flex-col gap-2 text-sm leading-6 text-white/80">
            {scopes.map((s) => (
              <li key={s} className="flex gap-2">
                <span aria-hidden="true" className="text-white/40">
                  •
                </span>
                {SCOPE_COPY[s]}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[12px] leading-5 text-white/45">
            Acting as {who}. Deleting a document still asks a person to confirm inside your agent.
          </p>
        </div>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <button type="submit" name="decision" value="allow" className={PRIMARY} disabled={workspaces.length === 0}>
            Allow
          </button>
          <button type="submit" name="decision" value="deny" className={QUIET}>
            Cancel
          </button>
          {client.clientUri ? (
            <a href={client.clientUri} target="_blank" rel="noreferrer" className="ml-auto text-[12px] text-white/45 underline-offset-4 hover:text-white hover:underline">
              About {client.clientName}
            </a>
          ) : null}
        </div>
      </form>
    </PublicGuideShell>
  );
}
