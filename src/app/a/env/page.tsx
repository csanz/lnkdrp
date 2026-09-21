/**
 * Admin route: `/a/env`
 *
 * Whether this deployment's configuration actually works — run against the deployment you are
 * looking at, which is the point. A local check can only ever tell you about the file on your
 * machine; this asks Vercel's own copy of the values whether Mongo answers, whether Google accepts
 * the client secret, whether the Stripe key opens the account the prices live in.
 *
 * Grouped, because that is how the question gets asked: "is auth fine, is the database fine".
 * A group is as good as its worst row, so one failure cannot hide under nine passes.
 *
 * Values never appear. The endpoint returns statuses and fingerprints (a length and four
 * characters) and nothing else, so this page is safe to screenshot into a chat.
 */
"use client";

import { useCallback, useEffect, useState } from "react";

import Button from "@/components/ui/Button";
import { AdminAccessState, AdminPageHeader, StatusPill, useAdminAccess } from "@/components/admin";

type Status = "ok" | "warn" | "fail" | "skip";
type Row = { name: string; group: string; status: Status; detail: string };
type Summary = { fail: number; warn: number; ok: number; skip: number; healthy: boolean };

/** Colour is meaning: a failure is the only thing that should read as red. */
const TONE: Record<Status, "positive" | "warning" | "danger" | "neutral"> = {
  ok: "positive",
  warn: "warning",
  fail: "danger",
  skip: "neutral",
};

/** Worst wins: a group with one failure is a failing group. */
function groupStatus(rows: Row[]): Status {
  if (rows.some((r) => r.status === "fail")) return "fail";
  if (rows.some((r) => r.status === "warn")) return "warn";
  if (rows.some((r) => r.status === "ok")) return "ok";
  return "skip";
}

export default function AdminEnvPage() {
  const access = useAdminAccess();
  const [rows, setRows] = useState<Row[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/env", { cache: "no-store" });
      if (!res.ok) throw new Error(`${res.status}`);
      const json = (await res.json()) as { results?: Row[]; summary?: Summary; checkedAt?: string };
      setRows(Array.isArray(json.results) ? json.results : []);
      setSummary(json.summary ?? null);
      setCheckedAt(json.checkedAt ?? null);
    } catch (e) {
      setError(e instanceof Error ? `Could not check (${e.message})` : "Could not check");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (access.canUseAdmin) void load();
  }, [access.canUseAdmin, load]);

  if (!access.canUseAdmin) {
    return (
      <AdminAccessState
        access={access}
        title="Environment"
        description="Whether this deployment's configuration actually works."
        callbackUrl="/a/env"
      />
    );
  }

  const groups = [...new Set(rows.map((r) => r.group))];

  return (
    <div className="grid gap-5">
      <AdminPageHeader
        title="Environment"
        description="Every credential this deployment needs, checked by using it. Values are never shown."
        actions={
          <Button onClick={() => void load()} disabled={loading} variant="secondary">
            {loading ? "Checking…" : "Re-check"}
          </Button>
        }
      />

      {error ? <div className="text-[13px] text-[var(--plan-ending-fg)]">{error}</div> : null}

      {summary ? (
        <div className="flex items-center gap-3 text-[13px] text-[var(--muted)]">
          <StatusPill tone={summary.healthy ? "positive" : "danger"} dot>
            {summary.healthy ? "Healthy" : `${summary.fail} failing`}
          </StatusPill>
          <span>
            {summary.ok} ok
            {summary.warn ? ` · ${summary.warn} warning` : ""}
            {summary.skip ? ` · ${summary.skip} skipped` : ""}
          </span>
          {checkedAt ? <span className="text-[var(--muted-2)]">checked {new Date(checkedAt).toLocaleTimeString()}</span> : null}
        </div>
      ) : null}

      {loading && !rows.length ? <div className="text-[13px] text-[var(--muted)]">Checking every credential…</div> : null}

      <div className="grid gap-4">
        {groups.map((group) => {
          const groupRows = rows.filter((r) => r.group === group);
          const status = groupStatus(groupRows);
          return (
            <section key={group} className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4">
              <div className="flex items-center gap-2">
                <StatusPill tone={TONE[status]} dot>
                  {status === "ok" ? "good" : status}
                </StatusPill>
                <h2 className="text-[13px] font-semibold uppercase tracking-[0.1em] text-[var(--muted-2)]">{group}</h2>
              </div>
              <ul className="mt-3 grid gap-1.5">
                {groupRows.map((r) => (
                  <li key={r.name} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[13px]">
                    <StatusPill tone={TONE[r.status]} className="shrink-0">
                      {r.status === "ok" ? "good" : r.status}
                    </StatusPill>
                    <span className="font-medium text-[var(--fg)]">{r.name}</span>
                    <span className="min-w-0 text-[var(--muted)]">{r.detail}</span>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
