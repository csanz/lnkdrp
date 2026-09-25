"use client";

/**
 * The Slack page (docs/prds/lnkdrp-slack.md, M1).
 *
 * Nothing connected: what it does and "Add to Slack", which is a plain link to the install route
 * (a redirect chain, not a fetch). Connected: one row per channel with the four event switches,
 * "Send a test message" and "Disconnect", a Default marker, "Add channel", and the projects each
 * channel is routed for (M3): a room or a request inbox picked on one card leaves any other card,
 * since one project posts to one channel. Owners and admins act; everyone else reads.
 */
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import AppPageHeader, { APP_PAGE_GUTTER } from "@/components/AppPageHeader";
import { usePlan } from "@/lib/client/usePlan";
import type { SlackConnectionDto, SlackEventKey } from "@/lib/slack/connections";
import { SlackMark, useSlackConnections, type SlackState } from "./slackShared";

const EVENT_COPY: Record<SlackEventKey, { title: string; body: string }> = {
  views: { title: "Opens", body: "The first time a recipient opens a share link." },
  briefs: { title: "Visit briefs", body: "The write-up after a recipient finishes reading (Pro)." },
  docUpdates: { title: "Replaced documents", body: "A new version of a document, with what changed." },
  requests: { title: "Received files", body: "A file dropped into a request inbox." },
};

const REASON_COPY: Record<string, string> = {
  denied: "You cancelled on Slack's side. Nothing was connected.",
  state: "That install link had expired or was not yours. Start again from this page.",
  code: "Slack did not send back a code. Start again from this page.",
  exchange: "Slack did not accept the install. Try again in a minute.",
  not_configured: "Slack is not set up on this deployment.",
};

type RoutableProject = { id: string; name: string; isRequest: boolean };

/**
 * Every room and request inbox in the workspace, for the picker. Two pages of fifty is far past
 * the plan caps; a workspace that somehow has more still sees the first hundred of each.
 */
async function loadRoutableProjects(): Promise<RoutableProject[]> {
  const out: RoutableProject[] = [];
  const pull = async (path: string, key: "projects" | "items", isRequest: boolean) => {
    for (let page = 1; page <= 2; page += 1) {
      const res = await fetch(`${path}?limit=50&page=${page}${isRequest ? "" : "&lite=1"}`, { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      const rows = Array.isArray(json?.[key]) ? (json![key] as Array<{ id?: unknown; name?: unknown }>) : [];
      for (const r of rows) if (typeof r?.id === "string") out.push({ id: r.id, name: typeof r.name === "string" && r.name.trim() ? r.name.trim() : "Untitled", isRequest });
      if (rows.length < 50) return;
    }
  };
  await Promise.all([pull("/api/projects", "projects", false), pull("/api/requests", "items", true)]);
  return out.sort((a, b) => Number(a.isRequest) - Number(b.isRequest) || a.name.localeCompare(b.name));
}

const BTN_PRIMARY =
  "inline-flex items-center justify-center rounded-lg bg-[var(--fg)] px-3 py-2 text-[13px] font-semibold text-[var(--bg)] hover:opacity-90 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]";
const BTN_SECONDARY =
  "inline-flex items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)] disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]";

export default function SlackPageClient({ initialSlack = null }: { initialSlack?: SlackState | null }) {
  const params = useSearchParams();
  const landed = params.get("slack");
  const reason = params.get("reason") ?? "";
  const { data, error, loading, refresh, setData } = useSlackConnections(initialSlack);
  const { plan } = usePlan();
  const canManage = plan?.role === "owner" || plan?.role === "admin";
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(
    landed === "connected"
      ? { tone: "ok", text: "Slack is connected. Send a test message to see it in the channel." }
      : landed === "error"
        ? { tone: "error", text: REASON_COPY[reason] ?? `Slack answered "${reason}". Try again.` }
        : null,
  );

  const call = useCallback(
    async (key: string, method: "PATCH" | "DELETE" | "POST", path: string, body: Record<string, unknown>) => {
      setBusy(key);
      setNotice(null);
      try {
        const res = await fetch(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        const json = (await res.json().catch(() => null)) as { error?: string; connections?: SlackConnectionDto[]; ok?: boolean; reason?: string } | null;
        if (!res.ok) throw new Error(json?.error || (json?.reason ? `Slack answered ${json.reason}.` : "Something went wrong."));
        if (json?.connections && data) setData({ ...data, connections: json.connections });
        return json;
      } catch (e) {
        setNotice({ tone: "error", text: e instanceof Error ? e.message : "Something went wrong." });
        return null;
      } finally {
        setBusy(null);
      }
    },
    [data, setData],
  );

  const connections = data?.connections ?? [];
  const enabled = data?.enabled ?? true;

  // The picker's options. Loaded once there is a channel to route to; not on the empty state.
  const [projects, setProjects] = useState<RoutableProject[] | null>(null);
  useEffect(() => {
    if (!connections.length || projects !== null) return;
    let alive = true;
    loadRoutableProjects()
      .then((rows) => {
        if (alive) setProjects(rows);
      })
      .catch(() => {
        if (alive) setProjects([]);
      });
    return () => {
      alive = false;
    };
  }, [connections.length, projects]);

  return (
    <div className="flex h-full flex-col">
      <AppPageHeader
        icon={SlackMark}
        title="Slack"
        description="Post what happens to your documents into a channel you choose. Private to your workspace; recipients never see it."
        actions={
          <Link href="/integrations" className="text-[13px] font-semibold text-[var(--muted-2)] underline-offset-4 hover:text-[var(--fg)] hover:underline">
            All integrations
          </Link>
        }
      />
      <div className={`min-h-0 flex-1 overflow-auto bg-[var(--bg)] ${APP_PAGE_GUTTER} py-6`} aria-busy={loading && !data}>
        {notice ? (
          <div
            role={notice.tone === "error" ? "alert" : "status"}
            className={[
              "mb-4 rounded-xl px-4 py-3 text-[13px] leading-5",
              notice.tone === "error" ? "bg-[var(--plan-ending-bg)] text-[var(--plan-ending-fg)]" : "border border-[var(--border)] bg-[var(--panel)] text-[var(--fg)]",
            ].join(" ")}
          >
            {notice.text}
          </div>
        ) : null}
        {error ? <div role="alert" className="mb-4 text-[13px] text-red-600 dark:text-red-400">{error}</div> : null}

        {!enabled ? (
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-6 text-[13px] leading-6 text-[var(--muted)]">
            Slack is not set up on this deployment. The Slack app&apos;s credentials are missing from the server configuration.
          </div>
        ) : !loading && connections.length === 0 ? (
          <div className="max-w-2xl rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-6">
            <div className="text-[15px] font-semibold text-[var(--fg)]">Nothing connected yet</div>
            <p className="mt-2 text-[13px] leading-6 text-[var(--muted)]">
              Add LinkDrop to a channel and pick which moments post there: a recipient opening a link, the brief after they finish reading, a replaced document, a file received in a request inbox. You choose the channel on Slack&apos;s screen; private channels work too. Add more channels later and route each project to its own.
            </p>
            {canManage ? (
              <a href="/api/slack/install" className={`${BTN_PRIMARY} mt-5 gap-2`}>
                <SlackMark className="h-4 w-4" /> Add to Slack
              </a>
            ) : (
              <p className="mt-5 text-[12px] text-[var(--muted-2)]">An owner or admin of this workspace can connect it.</p>
            )}
          </div>
        ) : (
          <div className="grid gap-4">
            {connections.map((c) => (
              <ChannelRow key={c.id} c={c} all={connections} projects={projects} canManage={canManage} busy={busy} call={call} setNotice={setNotice} />
            ))}
            {canManage ? (
              <div>
                <a href="/api/slack/install" className={`${BTN_SECONDARY} gap-2`}>
                  <SlackMark className="h-4 w-4" /> Add channel
                </a>
                <p className="mt-2 max-w-[70ch] text-[12px] leading-5 text-[var(--muted-2)]">
                  Want one project&apos;s activity in its own channel? Click Add channel, pick the channel on Slack&apos;s screen, then choose the project on the new card. Everything else keeps posting to the default channel. Each channel is its own install on Slack&apos;s side.
                </p>
              </div>
            ) : null}
          </div>
        )}
        {!loading && connections.length > 0 ? (
          <button type="button" onClick={() => void refresh()} className="mt-6 text-[12px] text-[var(--muted-2)] underline-offset-4 hover:underline">
            Refresh
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ChannelRow({
  c,
  all,
  projects,
  canManage,
  busy,
  call,
  setNotice,
}: {
  c: SlackConnectionDto;
  all: SlackConnectionDto[];
  projects: RoutableProject[] | null;
  canManage: boolean;
  busy: string | null;
  call: (key: string, method: "PATCH" | "DELETE" | "POST", path: string, body: Record<string, unknown>) => Promise<unknown>;
  setNotice: (n: { tone: "ok" | "error"; text: string } | null) => void;
}) {
  const revoked = c.status === "revoked";
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5 shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <SlackMark className="h-5 w-5" />
            <span className="text-[15px] font-semibold text-[var(--fg)]">{c.channelName}</span>
            {c.isDefault ? <span className="rounded-full border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 text-[11px] font-semibold text-[var(--muted-2)]"title="The catch-all: anything not routed to another channel posts here.">Default · catch-all</span> : null}
            {revoked ? <span className="rounded-full bg-[var(--plan-ending-bg)] px-2 py-0.5 text-[11px] font-semibold text-[var(--plan-ending-fg)]">Disconnected</span> : null}
          </div>
          <div className="mt-1 text-[12px] text-[var(--muted-2)]">
            {c.teamName}
            {c.lastPostAt ? ` · last post ${new Date(c.lastPostAt).toLocaleString()}` : " · nothing posted yet"}
          </div>
          {revoked ? (
            <p className="mt-2 text-[13px] leading-5 text-[var(--fg)]">
              Slack disconnected this channel{c.lastError ? ` (${c.lastError})` : ""}. The channel or the app was removed on Slack&apos;s side. Reconnect it with Add channel.
            </p>
          ) : c.lastError ? (
            <p className="mt-2 text-[12px] text-[var(--muted)]">Last error: {c.lastError}</p>
          ) : null}
        </div>
        {canManage ? (
          <div className="flex flex-wrap items-center gap-2">
            {!revoked ? (
              <button
                type="button"
                className={BTN_SECONDARY}
                disabled={busy !== null}
                onClick={async () => {
                  const r = (await call(`test:${c.id}`, "POST", "/api/orgs/active/slack/test", { connectionId: c.id })) as { ok?: boolean } | null;
                  if (r?.ok) setNotice({ tone: "ok", text: `Sent to ${c.channelName}.` });
                }}
              >
                {busy === `test:${c.id}` ? "Sending…" : "Send a test message"}
              </button>
            ) : null}
            {!c.isDefault && !revoked ? (
              <button type="button" className={BTN_SECONDARY} disabled={busy !== null} onClick={() => void call(`default:${c.id}`, "PATCH", "/api/orgs/active/slack", { connectionId: c.id, isDefault: true })}>
                Make default
              </button>
            ) : null}
            <button
              type="button"
              className="rounded-lg px-3 py-2 text-[13px] font-semibold text-[var(--muted-2)] hover:text-red-600 disabled:opacity-60"
              disabled={busy !== null}
              onClick={() => {
                if (!window.confirm(`Disconnect ${c.channelName}? Nothing will post there until it is reconnected.`)) return;
                void call(`delete:${c.id}`, "DELETE", "/api/orgs/active/slack", { connectionId: c.id });
              }}
            >
              Disconnect
            </button>
          </div>
        ) : null}
      </div>

      <ul className="mt-4 grid gap-2 sm:grid-cols-2">
        {(Object.keys(EVENT_COPY) as SlackEventKey[]).map((key) => {
          const on = c.events[key];
          return (
            <li key={key} className="flex items-start justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2.5">
              <div className="min-w-0">
                <div className="text-[13px] font-medium text-[var(--fg)]">{EVENT_COPY[key].title}</div>
                <div className="text-[12px] text-[var(--muted-2)]">{EVENT_COPY[key].body}</div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={`${EVENT_COPY[key].title} to ${c.channelName}`}
                disabled={!canManage || revoked || busy !== null}
                onClick={() => void call(`ev:${c.id}:${key}`, "PATCH", "/api/orgs/active/slack", { connectionId: c.id, events: { [key]: !on } })}
                className={[
                  "relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
                  on ? "bg-[var(--primary-bg)]" : "bg-[var(--border)]",
                  !canManage || revoked ? "opacity-50" : "cursor-pointer disabled:opacity-60",
                ].join(" ")}
              >
                <span
                  aria-hidden="true"
                  className={[
                    "inline-block h-4 w-4 transform rounded-full bg-[var(--panel)] shadow ring-1 ring-[var(--border)] transition-transform",
                    on ? "translate-x-[18px]" : "translate-x-0.5",
                  ].join(" ")}
                />
              </button>
            </li>
          );
        })}
      </ul>
      {!revoked ? <ProjectRouting c={c} all={all} projects={projects} canManage={canManage} busy={busy} call={call} /> : null}
      {c.configurationUrl ? (
        <p className="mt-3 text-[12px] text-[var(--muted-2)]">
          Remove the app on Slack&apos;s side from its{" "}
          <a href={c.configurationUrl} target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline">
            configuration page
          </a>
          .
        </p>
      ) : null}
    </div>
  );
}

/**
 * The projects this channel is routed for. Chips for what is mapped, a picker for the rest. A
 * project already on another card is offered with that channel's name and moves when picked
 * (the server pulls it from the other row). The default card says what falls through to it.
 */
function ProjectRouting({
  c,
  all,
  projects,
  canManage,
  busy,
  call,
}: {
  c: SlackConnectionDto;
  all: SlackConnectionDto[];
  projects: RoutableProject[] | null;
  canManage: boolean;
  busy: string | null;
  call: (key: string, method: "PATCH" | "DELETE" | "POST", path: string, body: Record<string, unknown>) => Promise<unknown>;
}) {
  const byId = new Map((projects ?? []).map((p) => [p.id, p]));
  const elsewhere = new Map<string, string>();
  for (const other of all) {
    if (other.id === c.id || other.status === "revoked") continue;
    for (const pid of other.projectIds) elsewhere.set(pid, other.channelName);
  }
  const mapped = c.projectIds;
  const options = (projects ?? []).filter((p) => !mapped.includes(p.id));
  const save = (projectIds: string[]) => void call(`route:${c.id}`, "PATCH", "/api/orgs/active/slack", { connectionId: c.id, projectIds });
  const saving = busy === `route:${c.id}`;
  const live = all.filter((x) => x.status !== "revoked");
  const onlyChannel = live.length <= 1;
  const defaultName = live.find((x) => x.isDefault)?.channelName ?? "the default channel";
  const noProjects = projects !== null && projects.length === 0;

  // What this card does with events, in words a person can act on. The default is the catch-all;
  // any other card receives nothing until a project is routed to it, and a workspace with no
  // projects is told that rather than shown an empty picker.
  const explain = c.isDefault
    ? onlyChannel
      ? "Everything posts here. To send one project's activity to its own channel, click Add channel below and pick the project on the new card."
      : mapped.length
        ? "The catch-all: these projects, plus anything not routed to another channel."
        : "The catch-all: anything not routed to another channel posts here."
    : noProjects
      ? `No projects yet, so there is nothing to route. Everything posts to ${defaultName} until a project is routed here or this channel is made the default. Create a project with the + next to Projects in the sidebar.`
      : mapped.length
        ? `Documents in these projects post here instead of ${defaultName}.`
        : options.length
          ? `Nothing posts here yet. Pick a project and its documents post here instead of ${defaultName}.`
          : `Nothing posts here yet. Every project is already routed; pick one from another card to move it here, or make this channel the default.`;
  const showPicker = canManage && projects !== null && options.length > 0 && !(c.isDefault && onlyChannel);

  return (
    <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-[var(--fg)]">{c.isDefault ? "Routing · catch-all" : "Routing"}</div>
          <div className="max-w-[60ch] text-[12px] leading-5 text-[var(--muted-2)]">{explain}</div>
        </div>
        {showPicker ? (
          <select
            aria-label={`Route a project to ${c.channelName}`}
            className="max-w-full rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2 py-1.5 text-[13px] text-[var(--fg)] disabled:opacity-60"
            value=""
            disabled={busy !== null}
            onChange={(e) => {
              const id = e.target.value;
              if (id) save([...mapped, id]);
            }}
          >
            <option value="">{saving ? "Saving…" : "Route a project…"}</option>
            {options.map((p) => {
              const other = elsewhere.get(p.id);
              return (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.isRequest ? " (request inbox)" : ""}
                  {other ? ` · now on ${other}` : ""}
                </option>
              );
            })}
          </select>
        ) : canManage && projects === null && !c.isDefault ? (
          <span className="text-[12px] text-[var(--muted-2)]">Loading projects…</span>
        ) : null}
      </div>
      {mapped.length ? (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {mapped.map((pid) => {
            const p = byId.get(pid);
            const name = p ? p.name : projects === null ? "…" : "A removed project";
            return (
              <li key={pid} className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--panel)] px-2.5 py-1 text-[12px] text-[var(--fg)]">
                <span className="max-w-[18rem] truncate">{name}</span>
                {p?.isRequest ? <span className="text-[var(--muted-2)]">inbox</span> : null}
                {canManage ? (
                  <button
                    type="button"
                    aria-label={`Stop routing ${name} to ${c.channelName}`}
                    disabled={busy !== null}
                    onClick={() => save(mapped.filter((x) => x !== pid))}
                    className="ml-0.5 rounded-full px-1 leading-none text-[var(--muted-2)] hover:text-[var(--fg)] disabled:opacity-60"
                  >
                    ×
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
