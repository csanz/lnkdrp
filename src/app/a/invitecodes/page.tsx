"use client";

import { useEffect, useMemo, useState } from "react";
import { signIn, useSession } from "next-auth/react";

type InviteRequestItem = {
  _id: string;
  requestEmail?: string | null;
  requestDescription?: string | null;
  createdDate?: string | null;
  approvedDate?: string | null;
  approvedInviteCode?: string | null;
  approvalEmailSentDate?: string | null;
  approvalEmailError?: string | null;
};

type InviteCodeItem = {
  _id: string;
  code?: string | null;
  isActive?: boolean | null;
  createdDate?: string | null;
};

function fmtDate(v: string | null | undefined) {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.valueOf())) return v;
  return d.toLocaleString();
}

export default function InviteCodesAdminPage() {
  const { data: session, status } = useSession();
  const role = session?.user?.role ?? null;
  const isAuthed = status === "authenticated";
  const isAdmin = isAuthed && role === "admin";
  const isLocalhost =
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
  const canUseAdmin = isAdmin || isLocalhost;

  const [menu, setMenu] = useState<"requests" | "codes">("requests");

  const [requestsTab, setRequestsTab] = useState<"pending" | "sent" | "approved">("pending");
  const [requestItems, setRequestItems] = useState<InviteRequestItem[]>([]);
  const [codeItems, setCodeItems] = useState<InviteCodeItem[]>([]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [creatingCode, setCreatingCode] = useState(false);
  const [togglingCodeId, setTogglingCodeId] = useState<string | null>(null);

  const filteredRequests = useMemo(() => requestItems, [requestItems]);
  const filteredCodes = useMemo(() => codeItems, [codeItems]);

  useEffect(() => {
    if (!canUseAdmin) return;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        if (menu === "requests") {
          const res = await fetch(`/api/invites/requests?status=${requestsTab}`, { method: "GET" });
          const data = (await res.json().catch(() => ({}))) as {
            ok?: unknown;
            error?: unknown;
            items?: unknown;
          };
          if (!res.ok) {
            setError(typeof data.error === "string" ? data.error : "Failed to load requests");
            setRequestItems([]);
            return;
          }
          setRequestItems(Array.isArray(data.items) ? (data.items as InviteRequestItem[]) : []);
        } else {
          const res = await fetch(`/api/invites/codes?status=all`, { method: "GET" });
          const data = (await res.json().catch(() => ({}))) as {
            ok?: unknown;
            error?: unknown;
            items?: unknown;
          };
          if (!res.ok) {
            setError(typeof data.error === "string" ? data.error : "Failed to load codes");
            setCodeItems([]);
            return;
          }
          setCodeItems(Array.isArray(data.items) ? (data.items as InviteCodeItem[]) : []);
        }
      } catch {
        setError(menu === "requests" ? "Failed to load requests" : "Failed to load codes");
        setRequestItems([]);
        setCodeItems([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [canUseAdmin, menu, requestsTab]);

  if (status === "loading") {
    return <div className="px-6 py-8 text-sm text-[var(--muted)]">Loading…</div>;
  }

  if (!isAuthed && !isLocalhost) {
    return (
      <div className="px-6 py-10">
        <div className="max-w-xl rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-6">
          <div className="text-base font-semibold text-[var(--fg)]">Invite admin</div>
          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
            You must be signed in to view this page.
          </p>
          <div className="mt-5">
            <button
              type="button"
              className="inline-flex items-center justify-center rounded-xl bg-[var(--primary-bg)] px-5 py-2.5 text-sm font-semibold text-[var(--primary-fg)] shadow-sm transition hover:bg-[var(--primary-hover-bg)]"
              onClick={() => void signIn("google", { callbackUrl: "/a/invitecodes" })}
            >
              Sign in
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!canUseAdmin) {
    return (
      <div className="px-6 py-10">
        <div className="max-w-xl rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-6">
          <div className="text-base font-semibold text-[var(--fg)]">Invite admin</div>
          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
            You don’t have access to this page.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100svh] bg-[var(--bg)] text-[var(--fg)]">
      <div className="mx-auto w-full max-w-5xl px-6 py-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-[var(--fg)]">Admin / Invites</h1>
            <p className="mt-1 text-sm text-[var(--muted)]">
              Manage invite codes and approve invite requests.
            </p>
          </div>
        </div>

        {error ? (
          <div className="mt-5 rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        <div className="mt-6 grid gap-5 md:grid-cols-[220px_1fr]">
          <aside className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-2">
            <button
              type="button"
              className={
                menu === "codes"
                  ? "w-full rounded-xl bg-[var(--panel-2)] px-3 py-2 text-left text-sm font-semibold text-[var(--fg)]"
                  : "w-full rounded-xl px-3 py-2 text-left text-sm text-[var(--muted)] hover:bg-[var(--panel-hover)]"
              }
              onClick={() => setMenu("codes")}
            >
              Codes
            </button>
            <button
              type="button"
              className={
                menu === "requests"
                  ? "mt-1 w-full rounded-xl bg-[var(--panel-2)] px-3 py-2 text-left text-sm font-semibold text-[var(--fg)]"
                  : "mt-1 w-full rounded-xl px-3 py-2 text-left text-sm text-[var(--muted)] hover:bg-[var(--panel-hover)]"
              }
              onClick={() => setMenu("requests")}
            >
              Requests
            </button>
          </aside>

          <section className="space-y-4">
            {menu === "requests" ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-[var(--fg)]">Invite requests</div>
                  <div className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-1 text-sm">
                    <button
                      type="button"
                      className={
                        requestsTab === "pending"
                          ? "rounded-lg bg-[var(--panel-2)] px-3 py-1.5 font-semibold text-[var(--fg)]"
                          : "rounded-lg px-3 py-1.5 text-[var(--muted)] hover:bg-[var(--panel-hover)]"
                      }
                      onClick={() => setRequestsTab("pending")}
                    >
                      Pending
                    </button>
                    <button
                      type="button"
                      className={
                        requestsTab === "sent"
                          ? "rounded-lg bg-[var(--panel-2)] px-3 py-1.5 font-semibold text-[var(--fg)]"
                          : "rounded-lg px-3 py-1.5 text-[var(--muted)] hover:bg-[var(--panel-hover)]"
                      }
                      onClick={() => setRequestsTab("sent")}
                    >
                      Sent
                    </button>
                    <button
                      type="button"
                      className={
                        requestsTab === "approved"
                          ? "rounded-lg bg-[var(--panel-2)] px-3 py-1.5 font-semibold text-[var(--fg)]"
                          : "rounded-lg px-3 py-1.5 text-[var(--muted)] hover:bg-[var(--panel-hover)]"
                      }
                      onClick={() => setRequestsTab("approved")}
                    >
                      Approved
                    </button>
                  </div>
                </div>

                {loading ? (
                  <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4 text-sm text-[var(--muted)]">
                    Loading…
                  </div>
                ) : filteredRequests.length === 0 ? (
                  <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4 text-sm text-[var(--muted)]">
                    No requests.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {filteredRequests.map((r) => (
                      <div
                        key={r._id}
                        className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-semibold text-[var(--fg)]">
                              {r.requestEmail ?? "(no email)"}
                            </div>
                            <div className="mt-1 text-xs text-[var(--muted-2)]">
                              Requested: {fmtDate(r.createdDate ?? null)}
                            </div>
                          </div>

                          {requestsTab === "pending" ? (
                            <button
                              type="button"
                              className="inline-flex items-center justify-center rounded-xl bg-[var(--primary-bg)] px-4 py-2 text-sm font-semibold text-[var(--primary-fg)] shadow-sm transition hover:bg-[var(--primary-hover-bg)] disabled:cursor-not-allowed disabled:opacity-70"
                              disabled={approvingId === r._id}
                              aria-busy={approvingId === r._id}
                              onClick={() => {
                                if (approvingId) return;
                                setApprovingId(r._id);
                                setError(null);
                                void (async () => {
                                  try {
                                    const res = await fetch(`/api/invites/requests/${r._id}/approve`, {
                                      method: "POST",
                                    });
                                    const data = (await res.json().catch(() => ({}))) as {
                                      ok?: unknown;
                                      error?: unknown;
                                    };
                                    if (!res.ok) {
                                      setError(typeof data.error === "string" ? data.error : "Failed to approve");
                                      return;
                                    }
                                    setRequestItems((prev) => prev.filter((x) => x._id !== r._id));
                                  } catch {
                                    setError("Failed to approve");
                                  } finally {
                                    setApprovingId(null);
                                  }
                                })();
                              }}
                            >
                              {approvingId === r._id ? "Approving…" : "Approve + email"}
                            </button>
                          ) : (
                            <div className="text-right text-xs text-[var(--muted-2)]">
                              <div>Approved: {fmtDate(r.approvedDate ?? null)}</div>
                              <div>
                                Code:{" "}
                                <span className="font-mono text-[var(--fg)]">
                                  {r.approvedInviteCode ?? "-"}
                                </span>
                              </div>
                              {r.approvalEmailSentDate ? (
                                <div>Email sent: {fmtDate(r.approvalEmailSentDate)}</div>
                              ) : r.approvalEmailError ? (
                                <div className="text-red-700">Email error: {r.approvalEmailError}</div>
                              ) : null}
                            </div>
                          )}
                        </div>

                        {r.requestDescription ? (
                          <div className="mt-3 text-sm leading-6 text-[var(--muted)]">
                            {r.requestDescription}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-[var(--fg)]">Invite codes</div>
                  <button
                    type="button"
                    className="inline-flex items-center justify-center rounded-xl bg-[var(--primary-bg)] px-4 py-2 text-sm font-semibold text-[var(--primary-fg)] shadow-sm transition hover:bg-[var(--primary-hover-bg)] disabled:cursor-not-allowed disabled:opacity-70"
                    disabled={creatingCode}
                    aria-busy={creatingCode}
                    onClick={() => {
                      if (creatingCode) return;
                      setCreatingCode(true);
                      setError(null);
                      void (async () => {
                        try {
                          const res = await fetch("/api/invites/codes", { method: "POST" });
                          const data = (await res.json().catch(() => ({}))) as {
                            ok?: unknown;
                            error?: unknown;
                            inviteId?: unknown;
                            inviteCode?: unknown;
                          };
                          if (!res.ok) {
                            setError(typeof data.error === "string" ? data.error : "Failed to create code");
                            return;
                          }
                          const inviteId = typeof data.inviteId === "string" ? data.inviteId : null;
                          const inviteCode = typeof data.inviteCode === "string" ? data.inviteCode : null;
                          if (inviteId && inviteCode) {
                            setCodeItems((prev) => [
                              {
                                _id: inviteId,
                                code: inviteCode,
                                isActive: true,
                                createdDate: new Date().toISOString(),
                              },
                              ...prev,
                            ]);
                          }
                        } catch {
                          setError("Failed to create code");
                        } finally {
                          setCreatingCode(false);
                        }
                      })();
                    }}
                  >
                    {creatingCode ? "Creating…" : "Create code"}
                  </button>
                </div>

                {loading ? (
                  <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4 text-sm text-[var(--muted)]">
                    Loading…
                  </div>
                ) : filteredCodes.length === 0 ? (
                  <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4 text-sm text-[var(--muted)]">
                    No codes.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {filteredCodes.map((c) => {
                      const active = c.isActive !== false;
                      return (
                        <div
                          key={c._id}
                          className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4"
                        >
                          <div className="min-w-0">
                            <div className="font-mono text-sm font-semibold text-[var(--fg)]">
                              {c.code ?? "-"}
                            </div>
                            <div className="mt-1 text-xs text-[var(--muted-2)]">
                              Created: {fmtDate(c.createdDate ?? null)}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="rounded-full border border-[var(--border)] bg-[var(--panel-2)] px-2 py-1 text-xs text-[var(--muted)]">
                              {active ? "Active" : "Inactive"}
                            </span>
                            <button
                              type="button"
                              className="inline-flex items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-2 text-sm font-semibold text-[var(--fg)] transition hover:bg-[var(--panel-hover)] disabled:cursor-not-allowed disabled:opacity-70"
                              disabled={togglingCodeId === c._id}
                              aria-busy={togglingCodeId === c._id}
                              onClick={() => {
                                if (togglingCodeId) return;
                                setTogglingCodeId(c._id);
                                setError(null);
                                void (async () => {
                                  try {
                                    const res = await fetch(`/api/invites/codes/${c._id}/toggle-active`, {
                                      method: "POST",
                                      headers: { "Content-Type": "application/json" },
                                      body: JSON.stringify({ isActive: !active }),
                                    });
                                    const data = (await res.json().catch(() => ({}))) as { error?: unknown };
                                    if (!res.ok) {
                                      setError(typeof data.error === "string" ? data.error : "Failed to update code");
                                      return;
                                    }
                                    setCodeItems((prev) =>
                                      prev.map((x) => (x._id === c._id ? { ...x, isActive: !active } : x)),
                                    );
                                  } catch {
                                    setError("Failed to update code");
                                  } finally {
                                    setTogglingCodeId(null);
                                  }
                                })();
                              }}
                            >
                              {togglingCodeId === c._id ? "Saving…" : active ? "Deactivate" : "Activate"}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}


