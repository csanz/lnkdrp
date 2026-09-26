/**
 * Who made this document — the author, and everyone who has worked on it since.
 *
 * A workspace where three people share a deck could tell you nothing about which of them wrote it,
 * replaced it, or minted the link a recipient is reading. The data was always there — `Doc.userId`
 * for the creator, the activity log for the rest — and no screen asked for it.
 *
 * Sits in the document's right rail beside the link, analytics and summary cards, and is built the
 * same way they are so the column reads as one thing.
 *
 * **Agents are shown, and marked.** An MCP client that files documents did the work, and hiding it
 * would misreport who did what; rendering it as a colleague would be worse. The chip matches the
 * one on the activity donut so the two screens agree about what an agent looks like.
 *
 * Renders nothing at all when there is no author and no contributor. An empty card on a document
 * only ever touched by one person is a permanent question nobody asked.
 */
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { UsersIcon } from "@heroicons/react/24/outline";

import { formatRelative } from "@/lib/analytics/reading/format";
import { initialsFromNameOrEmail } from "@/lib/format/initials";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";

type Contributor = {
  key: string;
  kind: "person" | "agent";
  name: string;
  email: string | null;
  actions: number;
  lastAt: string;
  /**
   * The page listing everything this contributor did, or null when the key cannot be addressed.
   *
   * The card used to be the end of the road: it named an agent and left you with no way to ask
   * what else it had touched. Built by `contributorHref`, never here, so this row and the feed
   * and the metrics list all point at the same page.
   */
  href: string | null;
  /** Agents only: the member who connected the client. Null for people, and for an unknown owner. */
  ownerUserId: string | null;
};

type Authorship = { author: Contributor | null; contributors: Contributor[] };

const NAME_CLASS = "truncate text-[13px] font-medium text-[var(--fg)]";
/** The feed's link treatment, copied so a name that leads somewhere looks the same on both screens. */
const LINK_CLASS =
  "underline decoration-dotted decoration-[var(--muted-2)] underline-offset-4 transition-colors hover:decoration-solid hover:decoration-[var(--fg)]";

/** One row: a mark, a name, and what they last did. */
function Person({ person, role, now }: { person: Contributor; role?: string; now: number }) {
  const isAgent = person.kind === "agent";
  // `lastAt` is the epoch when the creator has no recorded work — a document added before the
  // activity log covered it. "Last worked on it 56 years ago" is worse than saying nothing.
  const hasWork = Boolean(person.lastAt) && person.lastAt !== new Date(0).toISOString();
  const when = hasWork ? formatRelative(person.lastAt, now) : null;

  return (
    <li className="flex items-center gap-2.5">
      <span
        aria-hidden="true"
        className={[
          "grid h-7 w-7 shrink-0 place-items-center rounded-full text-[10px] font-semibold ring-1 ring-[var(--border)]",
          isAgent ? "bg-[var(--panel)] text-[var(--muted-2)]" : "bg-[var(--panel-hover)] text-[var(--muted)]",
        ].join(" ")}
        title={isAgent ? `${person.name} · agent` : (person.email ?? person.name)}
      >
        {/* An agent gets a glyph rather than initials: "NS" for Northwind Seed reads as a person. */}
        {isAgent ? <UsersIcon className="h-3.5 w-3.5" /> : initialsFromNameOrEmail(person.name)}
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          {/* A dotted rule, the same one the activity feed puts under a name it can follow: enough
              to say the name goes somewhere, not enough to turn a quiet card in the rail into a
              row of buttons. Unlinked when there is no page to open, which is a tombstoned member
              or a key this build cannot address, never a styling choice. */}
          {person.href ? (
            <Link
              href={person.href}
              title={isAgent ? "See everything this agent changed" : "See everything they changed"}
              className={[NAME_CLASS, LINK_CLASS].join(" ")}
            >
              {person.name}
            </Link>
          ) : (
            <span className={NAME_CLASS}>{person.name}</span>
          )}
          {isAgent ? (
            <span
              className="shrink-0 rounded px-1 py-px text-[9px] font-semibold uppercase tracking-[0.06em] text-[var(--muted-2)] ring-1 ring-[var(--border)]"
              title="Worked through the MCP, not in the app"
            >
              Agent
            </span>
          ) : null}
        </span>
        <span className="block truncate text-[11px] leading-4 text-[var(--muted-2)]">
          {role ? role : when ? `Last worked on it ${when}` : `${person.actions} ${person.actions === 1 ? "action" : "actions"}`}
        </span>
      </span>
    </li>
  );
}

export default function ContributorsCard({ docId }: { docId: string }) {
  const [data, setData] = useState<Authorship | null>(null);
  // "Last worked on it 3 h ago" is relative to the moment the list was fetched, not to each
  // re-render: reading the clock during render is impure, and a row that silently ages between
  // renders while its neighbour does not is the visible symptom.
  const [now, setNow] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetchWithTempUser(`/api/docs/${encodeURIComponent(docId)}/contributors`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const json = (await res.json()) as Authorship;
        if (!cancelled) {
          setNow(Date.now());
          setData(json);
        }
      } catch {
        // An aid, never a precondition for reading the document.
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [docId]);

  if (!data) return null;
  const { author, contributors } = data;
  if (!author && !contributors.length) return null;

  return (
    <div className="mt-4">
      <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-5 py-4">
        <div className="mb-3 flex items-center justify-between gap-3 border-b border-[var(--divider)] pb-3">
          <div
            className="inline-flex min-w-0 items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]"
            title="Who created this document and who has worked on it"
          >
            <UsersIcon className="h-4 w-4 text-[var(--muted)]" aria-hidden="true" />
            {/*
              "Contributors", not "People". One of the rows is routinely an agent, marked as one -
              so a heading that calls the list people is contradicted by its own contents, and by
              this component's own `kind: "person" | "agent"`. Contributors is true of both, and is
              what the card was named after.
            */}
            <span className="truncate">Contributors</span>
          </div>
          {contributors.length ? (
            <span className="shrink-0 text-[11px] tabular-nums text-[var(--muted-2)]">
              {contributors.length + (author ? 1 : 0)}
            </span>
          ) : null}
        </div>

        <ul className="grid gap-2.5">
          {author ? <Person person={author} role="Added this document" now={now} /> : null}
          {contributors.map((c) => (
            <Person key={c.key} person={c} now={now} />
          ))}
        </ul>

        {!contributors.length && author ? (
          <div className="mt-3 text-[11px] leading-4 text-[var(--muted-2)]">
            Nobody else has worked on it yet.
          </div>
        ) : null}
      </div>
    </div>
  );
}
