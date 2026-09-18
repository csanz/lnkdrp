/**
 * AdminAccessState — the three screens an admin page shows before its content.
 *
 * Loading, sign-in-needed and access-denied were the one surface the admin restyle
 * skipped: eighteen pages hand-rolled `px-6 py-10` + `max-w-xl rounded-2xl`, off-system
 * and nothing like the page that replaces it. They are the *first* paint of every admin
 * route, so they are the page shape: `ADMIN_PAGE_CONTAINER`, `AdminPageHeader`, then one
 * panel.
 *
 *   const access = useAdminAccess();
 *   …
 *   if (!access.canUseAdmin) {
 *     return <AdminAccessState access={access} title="Users" description="…" callbackUrl="/a/data/users" />;
 *   }
 */
"use client";

import { signIn } from "next-auth/react";
import Button from "@/components/ui/Button";
import AdminPageHeader from "./AdminPageHeader";
import { ADMIN_PAGE_CONTAINER } from "@/lib/admin/layout";
import { ADMIN_PANEL_TEXT } from "@/lib/admin/ui";
import type { AdminAccess } from "@/lib/admin/useAdminAccess";

export type AdminAccessStateProps = {
  access: AdminAccess;
  /** The page's own title — the skeleton must look like the page that follows it. */
  title: string;
  description?: React.ReactNode;
  /** Where to return after signing in. Defaults to the current path. */
  callbackUrl?: string;
};

/** The page shell used for loading / signed-out / not-an-admin. */
export default function AdminAccessState({ access, title, description, callbackUrl }: AdminAccessStateProps) {
  const body = access.pending ? (
    // Neutral skeleton: the real page shape, so nothing jumps when the content arrives.
    <div
      role="status"
      aria-live="polite"
      className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-10 text-center text-[13px] text-[var(--muted-2)]"
    >
      Loading…
    </div>
  ) : access.needsSignIn ? (
    <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-5">
      <p className={ADMIN_PANEL_TEXT}>You must be signed in to view this page.</p>
      <div className="mt-4">
        <Button
          variant="solid"
          className="bg-[var(--primary-bg)] px-5 py-2.5 text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)]"
          onClick={() =>
            void signIn("google", {
              callbackUrl: callbackUrl ?? (typeof window !== "undefined" ? window.location.pathname : "/a"),
            })
          }
        >
          Sign in
        </Button>
      </div>
    </div>
  ) : (
    <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-5">
      <p className={ADMIN_PANEL_TEXT}>You don’t have access to this page.</p>
    </div>
  );

  return (
    <div className="min-h-[100svh] bg-[var(--bg)] text-[var(--fg)]">
      <div className={ADMIN_PAGE_CONTAINER}>
        <AdminPageHeader title={title} description={description} />
        {body}
      </div>
    </div>
  );
}
