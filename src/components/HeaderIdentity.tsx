/**
 * The parts of a sub-page header that name the thing you are inside — and the one rule they all
 * follow: a header never prints a generic noun where a name goes.
 *
 * "Project" and "Document" used to stand in while the real name was still being fetched. The band
 * titled itself with a word shaped like a name and then renamed itself a beat later, which reads as
 * the page having been about something else for a moment. Everything here waits visibly instead —
 * the same pulsing bar the project page already shows — and stops waiting the moment the read
 * settles, because a skeleton that never resolves is the worse lie.
 */
"use client";

import Link from "next/link";
import type { ReactElement } from "react";

import { useEntityIdentity } from "@/lib/client/entityIdentity";
import { type EntityKind, useEntityTitle } from "@/lib/client/entityTitles";

/** What a nameless resource is called once the read has come back without one. */
function untitled(kind: EntityKind): string {
  return kind === "project" ? "Untitled project" : "Untitled document";
}

/**
 * The bar that stands where a name will be.
 *
 * One definition, so the pulse is the same width and weight wherever a header is still waiting.
 */
export function HeaderNameSkeleton({ kind }: { kind: EntityKind }) {
  return (
    <span
      className="block h-5 w-40 animate-pulse rounded bg-[var(--panel-hover)]"
      aria-label={`Loading ${kind === "project" ? "project" : "document"} name`}
    />
  );
}

/**
 * The name to paint right now, and whether waiting for it is still honest.
 *
 * Precedence is the caller's own value first — a page that already fetched the name, or was handed
 * one by the row it was reached from — then this session's shared read, then whatever this browser
 * last knew the resource to be called.
 */
export function useHeaderName(kind: EntityKind, id: string, seed?: string): { name: string; settled: boolean } {
  const remembered = useEntityTitle(kind, id);
  const { identity, settled } = useEntityIdentity(kind, id);
  const name = seed?.trim() || identity?.name?.trim() || remembered || "";
  return { name, settled };
}

/**
 * A resource's name in a header's title slot: the name, a skeleton, or — once nothing more is
 * coming — the honest admission that it has none.
 */
export function EntityHeaderName({
  kind,
  id,
  name,
  href,
}: {
  kind: EntityKind;
  id: string;
  /** A name the page already has, if any. */
  name?: string;
  /** Where the name points, when the caller has not already wrapped it in a link. */
  href?: string;
}): ReactElement {
  const { name: shown, settled } = useHeaderName(kind, id, name);
  if (shown) {
    return href ? (
      <Link
        href={href}
        className="min-w-0 truncate text-lg font-semibold tracking-tight text-[var(--fg)] hover:underline underline-offset-4"
      >
        {shown}
      </Link>
    ) : (
      <>{shown}</>
    );
  }
  if (settled) {
    return (
      <span className="min-w-0 truncate text-lg font-semibold tracking-tight text-[var(--muted)]">
        {untitled(kind)}
      </span>
    );
  }
  return <HeaderNameSkeleton kind={kind} />;
}

/**
 * The waiting shape for a crumb whose text is a name that has not arrived.
 *
 * Narrower and thinner than `HeaderNameSkeleton` because the crumb row is 13px text, and a bar the
 * size of the title would read as a second, larger heading.
 */
export function CrumbSkeleton({ label }: { label?: string } = {}) {
  return (
    <>
      {/* `SubPageHeader` wraps the first crumb in a `<Link>`, so a pulse that is entirely
          aria-hidden leaves that link with no accessible name for as long as the read is out.
          The word is available to assistive tech and invisible on screen. */}
      {label ? <span className="sr-only">{label}</span> : null}
      <span
        className="inline-block h-3 w-16 animate-pulse rounded bg-[var(--panel-hover)] align-middle"
        aria-hidden="true"
      />
    </>
  );
}

/**
 * The first crumb of a sub-page: the hierarchy word for the resource above this page.
 *
 * The word itself is right — "Project › Metrics" is what the trail is — but it must not be the only
 * text in the band. While the title beside it was a skeleton this crumb sat alone at the top left,
 * where the name goes, and got read as the title; then the real name appeared above it and the page
 * looked like it had renamed itself. That is the reported bug, verbatim. So the crumb waits with the
 * title and appears with it, and prints the noun the moment the read settles either way.
 */
export default function EntityCrumbLabel({
  kind,
  id,
  noun,
  name,
}: {
  kind: EntityKind;
  id: string;
  /** "Project" or "Document" — the hierarchy word, never a stand-in for the name. */
  noun: string;
  /** A name the page already has, if any. */
  name?: string;
}) {
  const { name: shown, settled } = useHeaderName(kind, id, name);
  if (shown || settled) return <>{noun}</>;
  return <CrumbSkeleton label={noun} />;
}
