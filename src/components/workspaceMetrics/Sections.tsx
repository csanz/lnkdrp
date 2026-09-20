"use client";

/**
 * The ranked sections under the hero chart on `/metrics`: top documents, top links, most engaged
 * people and the documents that have gone quiet.
 *
 * Every row that can lead somewhere does: a document row opens its own metrics page, a link row
 * opens that page filtered to the link, a quiet document opens the page that will tell the sender
 * whether it was ever read. This page ranks; the document pages drill down (that separation is the
 * lesson the 2026-09-17 redesign rollback left behind).
 *
 * People are Pro only ([[viewer identity gate]]): on Free the API sends a count and no names, so
 * this file has no branch that could render an identity it was not given.
 */
import Link from "next/link";

import PlanLimitNotice from "@/components/PlanLimitNotice";
import { CpuChipIcon } from "@heroicons/react/24/outline";

import { formatDwell, formatRelative } from "@/lib/analytics/reading/format";
import { initialsFromNameOrEmail } from "@/lib/format/initials";
import { formatInt } from "@/lib/format/number";
import type {
  WorkspaceContributor,
  WorkspacePeople,
  WorkspaceQuietDoc,
  WorkspaceTopDoc,
  WorkspaceTopLink,
} from "@/lib/analytics/workspace/types";
import { linkDisplayName, peopleCountSentence } from "./format";

const ROW_LINK_CLASS =
  "group flex items-start gap-3 px-4 py-3 outline-none transition-colors hover:bg-[var(--panel-hover)] focus-visible:bg-[var(--panel-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ring)]";
const ROW_CLASS = "flex items-start gap-3 px-4 py-3";
const TITLE_CLASS = "truncate text-[13px] font-semibold leading-5 text-[var(--fg)]";
const META_CLASS = "mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[var(--muted-2)]";

/** Section frame: the small uppercase header every list on this page shares, then a rounded panel. */
function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="min-w-0">
      <div className="mb-2 flex items-baseline justify-between gap-3 px-1">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-2)]">{title}</h2>
        {hint ? <span className="shrink-0 text-[11px] text-[var(--muted-2)]">{hint}</span> : null}
      </div>
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)]">{children}</div>
    </section>
  );
}

/**
 * The one-line stand-in a section shows instead of rows when it has nothing to rank.
 *
 * Left-aligned and short on purpose: centred inside a tall panel it made the emptiest card on the
 * page the one the eye went to, and on a small workspace it padded a column that already ended well
 * above its neighbour. It reads as a footnote now, which is what it is.
 */
function EmptyRow({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-5 text-[13px] text-[var(--muted)]">{children}</p>;
}

/** The divided row list inside a section panel, with the corners rounded on the end rows. */
function List({ children }: { children: React.ReactNode }) {
  return (
    <ul className="divide-y divide-[var(--border)] [&>li:first-child>a]:rounded-t-2xl [&>li:last-child>a]:rounded-b-2xl">{children}</ul>
  );
}

/** A right-aligned figure with its noun under it, so the numbers line up down the card. */
function RowFigure({ value, label }: { value: string; label: string }) {
  return (
    <div className="shrink-0 text-right">
      <div className="text-[13px] font-semibold tabular-nums leading-5 text-[var(--fg)]">{value}</div>
      <div className="text-[10px] leading-4 text-[var(--muted-2)]">{label}</div>
    </div>
  );
}

/** "opened 2 days ago", or nothing at all when a row has never been opened. */
function lastOpened(iso: string | null, now: number, verb = "opened"): string | null {
  if (!iso) return null;
  return `${verb} ${formatRelative(iso, now)}`;
}

/** Documents ranked by views, each row opening its own metrics page. */
export function TopDocsSection({
  docs,
  now,
  opensPartial,
}: {
  docs: WorkspaceTopDoc[];
  now: number;
  /** True when the window's visit rows are incomplete, which hides the opens figure per row. */
  opensPartial: boolean;
}) {
  return (
    <Section title="Top documents" hint={docs.length ? "by views" : undefined}>
      {docs.length ? (
        <List>
          {docs.map((d) => {
            const opened = lastOpened(d.lastOpenedAt, now);
            return (
              <li key={d.docId}>
                <Link href={d.href} className={ROW_LINK_CLASS} title={d.title}>
                  <div className="min-w-0 flex-1">
                    <div className={TITLE_CLASS}>{d.title}</div>
                    {/*
                      No viewer count beside the view count: a `shareviews` row is unique per
                      (link, browser), so the two are the same number on every real row and the
                      card printed "40 viewers … 40 views". Opens is the figure that differs, and
                      it is absent rather than zero on traffic older than visit rows.
                    */}
                    <div className={META_CLASS}>
                      {opensPartial ? null : (
                        <>
                          <span className="tabular-nums">{formatInt(d.opens)} {d.opens === 1 ? "open" : "opens"}</span>
                          <span aria-hidden="true">·</span>
                        </>
                      )}
                      <span className="tabular-nums">{formatDwell(d.avgReadingTimeMs)} avg</span>
                      {opened ? (
                        <>
                          <span aria-hidden="true">·</span>
                          <time dateTime={d.lastOpenedAt ?? undefined} title={d.lastOpenedAt ?? undefined}>
                            {opened}
                          </time>
                        </>
                      ) : null}
                    </div>
                  </div>
                  <RowFigure value={formatInt(d.views)} label={d.views === 1 ? "view" : "views"} />
                </Link>
              </li>
            );
          })}
        </List>
      ) : (
        <EmptyRow>No documents were opened in this period.</EmptyRow>
      )}
    </Section>
  );
}

/**
 * The folder a project link's row is marked with.
 *
 * A project link and a document link look identical otherwise — a label over a name — but they lead
 * to different pages and count different things (a project link's figures cover every document
 * opened through it), so the glyph is what tells a reader which kind of row they are about to open.
 */
function ProjectGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--muted-2)]"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M1.75 4.25a1 1 0 0 1 1-1h3.1a1 1 0 0 1 .8.4l.7.95a1 1 0 0 0 .8.4h4.1a1 1 0 0 1 1 1v5.6a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z" />
    </svg>
  );
}

/**
 * Links ranked by views — one row per link, of either kind.
 *
 * A document link opens its document's metrics filtered to the link; a project link opens its
 * *project's* metrics filtered to the link, and carries the project's name (and a folder) under its
 * label rather than a document title. The payload's `kind` is the only thing this file branches on:
 * which page a row belongs to is the server's decision, not a guess from the shape of the href.
 */
export function TopLinksSection({ links, now }: { links: WorkspaceTopLink[]; now: number }) {
  return (
    <Section title="Top links" hint={links.length ? "by views" : undefined}>
      {links.length ? (
        <List>
          {links.map((l) => {
            const name = linkDisplayName(l);
            const opened = lastOpened(l.lastOpenedAt, now);
            const isProject = l.kind === "project";
            return (
              // One row per shareId — a project link's documents are summed into it upstream — so
              // the shareId alone is unique and no two rows can share a key.
              <li key={l.shareId}>
                <Link
                  href={l.href}
                  className={ROW_LINK_CLASS}
                  title={`${name} · ${isProject ? `${l.parentName} (project)` : l.parentName}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className={TITLE_CLASS}>{name}</div>
                    <div className="flex min-w-0 items-start gap-1 text-[12px] leading-4 text-[var(--muted)]">
                      {isProject ? <ProjectGlyph /> : null}
                      <span className="truncate">{l.parentName}</span>
                    </div>
                    {/* Same duplication as the document row above: viewers == views per link. */}
                    <div className={META_CLASS}>
                      {opened ? (
                        <time dateTime={l.lastOpenedAt ?? undefined} title={l.lastOpenedAt ?? undefined}>
                          {opened}
                        </time>
                      ) : null}
                    </div>
                  </div>
                  <RowFigure value={formatInt(l.views)} label={l.views === 1 ? "view" : "views"} />
                </Link>
              </li>
            );
          })}
        </List>
      ) : (
        <EmptyRow>No links were opened in this period.</EmptyRow>
      )}
    </Section>
  );
}

/** Named readers ranked by reading time (Pro); on Free, the count and the upgrade notice. */
export function PeopleSection({ people, now }: { people: WorkspacePeople; now: number }) {
  return (
    <Section title="Most engaged people" hint={people.items.length ? "by reading time" : undefined}>
      {people.gated ? (
        <div className="px-4 py-4">
          <p className="text-[13px] text-[var(--fg)]">{peopleCountSentence(people.count)}</p>
          <PlanLimitNotice limit="analytics_history" secondaryHref="/pricing" className="mt-3" compact />
        </div>
      ) : people.items.length ? (
        <ul className="divide-y divide-[var(--border)]">
          {people.items.map((p) => {
            const display = p.name || p.email || "Unknown";
            const seen = lastOpened(p.lastSeenAt, now, "last seen");
            return (
              <li key={p.key} className={ROW_CLASS}>
                <span
                  aria-hidden="true"
                  title={p.email ?? display}
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[var(--panel-hover)] text-[10px] font-semibold text-[var(--muted)] ring-1 ring-[var(--border)]"
                >
                  {initialsFromNameOrEmail(display)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className={TITLE_CLASS}>{display}</div>
                  {p.name && p.email ? <div className="truncate text-[12px] leading-4 text-[var(--muted)]">{p.email}</div> : null}
                  <div className={META_CLASS}>
                    <span className="tabular-nums">{formatInt(p.docs)} {p.docs === 1 ? "document" : "documents"}</span>
                    {seen ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <time dateTime={p.lastSeenAt ?? undefined} title={p.lastSeenAt ?? undefined}>
                          {seen}
                        </time>
                      </>
                    ) : null}
                  </div>
                </div>
                <RowFigure value={formatDwell(p.readingTimeMs)} label="reading" />
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyRow>Nobody identified themselves in this period.</EmptyRow>
      )}
    </Section>
  );
}

/**
 * Documents with a live link that nobody opened in the range — who to nudge, newest share first.
 *
 * The hint names the rule rather than asserting a duration: "no opens in 90 days" sat above eight
 * rows that all read "shared 2 hours ago", which cannot both be true. The API also holds a freshly
 * shared document back for a day, so the list ranks documents that have actually gone quiet.
 */
/**
 * Who did the work: people in the app and agents through the MCP, most actions first.
 *
 * Every other section on this page counts what readers did. This one counts what the workspace's
 * own side did, and keeps the agent apart from the person whose key it used — "Claude Code filed
 * nine documents" is the fact worth seeing, and folding it into a teammate's row would hide it.
 */
export function ContributorsSection({ contributors, now }: { contributors: WorkspaceContributor[]; now: number }) {
  return (
    <Section title="Who contributed" hint={contributors.length ? "by actions" : undefined}>
      {contributors.length ? (
        <ul className="divide-y divide-[var(--border)]">
          {contributors.map((c) => {
            const active = lastOpened(c.lastActiveAt, now, "last active");
            // Only the counts that happened, so a link-only contributor does not read "0 documents".
            const parts: string[] = [];
            if (c.docsAdded) parts.push(`${formatInt(c.docsAdded)} ${c.docsAdded === 1 ? "document" : "documents"}`);
            if (c.linksCreated) parts.push(`${formatInt(c.linksCreated)} ${c.linksCreated === 1 ? "link" : "links"}`);
            if (c.docsReplaced) parts.push(`${formatInt(c.docsReplaced)} ${c.docsReplaced === 1 ? "replacement" : "replacements"}`);
            return (
              <li key={c.key} className={ROW_CLASS}>
                <span
                  aria-hidden="true"
                  title={c.kind === "agent" ? `${c.name} · agent` : c.email ?? c.name}
                  className={[
                    "grid h-7 w-7 shrink-0 place-items-center rounded-full text-[10px] font-semibold ring-1",
                    c.kind === "agent"
                      ? "bg-[var(--panel-2)] text-[var(--fg)] ring-[var(--fg)]/30"
                      : "bg-[var(--panel-hover)] text-[var(--muted)] ring-[var(--border)]",
                  ].join(" ")}
                >
                  {c.kind === "agent" ? <CpuChipIcon className="h-3.5 w-3.5" /> : initialsFromNameOrEmail(c.name)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className={TITLE_CLASS}>{c.name}</span>
                    {c.kind === "agent" ? (
                      <span className="shrink-0 rounded-md bg-[var(--panel-hover)] px-1.5 py-px text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-2)]">
                        Agent
                      </span>
                    ) : null}
                  </div>
                  <div className={META_CLASS}>
                    {parts.length ? <span className="tabular-nums">{parts.join(" · ")}</span> : <span>other actions</span>}
                    {active ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <time dateTime={c.lastActiveAt ?? undefined} title={c.lastActiveAt ?? undefined}>
                          {active}
                        </time>
                      </>
                    ) : null}
                  </div>
                </div>
                <RowFigure value={formatInt(c.actions)} label={c.actions === 1 ? "action" : "actions"} />
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyRow>Nothing was added or shared in this period.</EmptyRow>
      )}
    </Section>
  );
}

export function QuietDocsSection({ docs, now }: { docs: WorkspaceQuietDoc[]; now: number }) {
  return (
    <Section title="Gone quiet" hint={docs.length ? "shared, not opened" : undefined}>
      {docs.length ? (
        <List>
          {docs.map((d) => (
            <li key={d.docId}>
              <Link href={d.href} className={ROW_LINK_CLASS} title={d.title}>
                <div className="min-w-0 flex-1">
                  <div className={TITLE_CLASS}>{d.title}</div>
                  <div className={META_CLASS}>
                    {d.sharedAt ? (
                      <time dateTime={d.sharedAt} title={d.sharedAt}>
                        shared {formatRelative(d.sharedAt, now)}
                      </time>
                    ) : (
                      <span>shared</span>
                    )}
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </List>
      ) : (
        <EmptyRow>Every document with a live link was opened in this period.</EmptyRow>
      )}
    </Section>
  );
}
