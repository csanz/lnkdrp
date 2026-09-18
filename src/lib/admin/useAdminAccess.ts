/**
 * Who may see an admin page — decided once, and only on the client.
 *
 * Every admin page used to open with:
 *
 *     const isLocalhost = typeof window !== "undefined" && …;
 *     const canUseAdmin = isAdmin || isLocalhost;
 *
 * `typeof window` is a server/client branch, so the server rendered the access-denied
 * card and the client threw it away and rendered the real page: a React hydration
 * mismatch on every admin route, and a visible flash of the wrong screen followed by a
 * full re-render of the table.
 *
 * The fix is to agree with the server. Until `mounted` flips, nobody can use the admin
 * area and the page renders a neutral skeleton in the real page shape; the access
 * question is only asked afterwards, when `window` genuinely exists.
 */
"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";

export type AdminAccess = {
  /** False on the server and on the first client render — the two therefore agree. */
  mounted: boolean;
  /** Still resolving: not mounted yet, or next-auth has not answered. Render the skeleton. */
  pending: boolean;
  /** Signed in (whatever the role). */
  isAuthed: boolean;
  /** Signed in as an admin. */
  isAdmin: boolean;
  /** Admin, or on a developer's own machine. */
  canUseAdmin: boolean;
  /** Nobody is signed in and this is not localhost: offer the sign-in button. */
  needsSignIn: boolean;
};

/** Resolve admin access without disagreeing with the server render. */
export function useAdminAccess(): AdminAccess {
  const { data: session, status } = useSession();
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const isLocalhost =
    mounted &&
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");

  const isAuthed = status === "authenticated";
  const isAdmin = isAuthed && (session?.user?.role ?? null) === "admin";
  const pending = !mounted || status === "loading";

  return {
    mounted,
    pending,
    isAuthed,
    isAdmin,
    canUseAdmin: mounted && (isAdmin || isLocalhost),
    needsSignIn: !pending && !isAuthed && !isLocalhost,
  };
}
