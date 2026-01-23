"use client";

import { useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import {
  ORGS_CACHE_UPDATED_EVENT,
  readOrgsCacheSnapshot,
  refreshOrgsCache,
} from "@/lib/orgsCache";
import { stableSortOrgs, type OrgRow } from "@/lib/orgs/orgsClient";

/**
 * Client hook to read the "orgs cache" snapshot and keep it fresh.
 *
 * This is a UX helper only; the server remains the source of truth for tenancy.
 */
export function useOrgsSnapshot() {
  const { data: session } = useSession();

  const userKey = useMemo(() => (session?.user?.email ?? "").trim(), [session?.user?.email]);

  const [orgsBusy, setOrgsBusy] = useState(false);
  const [orgsError, setOrgsError] = useState<string | null>(null);
  const [orgs, setOrgs] = useState<OrgRow[]>([]);
  const [serverActiveOrgId, setServerActiveOrgId] = useState<string | null>(null);

  // Prefer the server-reported active org (it is the source of truth), fall back to session.
  const activeOrgId = serverActiveOrgId ?? ((session as any)?.activeOrgId ?? null);

  const stableOrgs = useMemo(() => stableSortOrgs(orgs), [orgs]);

  useEffect(() => {
    if (!userKey) return;
    let cancelled = false;

    const cached = readOrgsCacheSnapshot(userKey);
    if (cached) {
      setOrgs(Array.isArray(cached.orgs) ? (cached.orgs as OrgRow[]) : []);
      setServerActiveOrgId(typeof cached.activeOrgId === "string" ? cached.activeOrgId : null);
      setOrgsError(null);
    } else {
      setOrgsBusy(true);
      setOrgsError(null);
    }

    void (async () => {
      try {
        const snap = await refreshOrgsCache({ userKey, force: true });
        if (cancelled) return;
        if (snap) {
          setOrgs(Array.isArray(snap.orgs) ? (snap.orgs as OrgRow[]) : []);
          setServerActiveOrgId(typeof snap.activeOrgId === "string" ? snap.activeOrgId : null);
          setOrgsError(null);
        }
      } catch (e) {
        if (cancelled) return;
        if (!cached) {
          setOrgs([]);
          setOrgsError(e instanceof Error ? e.message : "Failed to load workspaces");
          setServerActiveOrgId(null);
        }
      } finally {
        if (!cancelled) setOrgsBusy(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userKey]);

  useEffect(() => {
    if (!userKey) return;

    function onCacheUpdated() {
      const snap = readOrgsCacheSnapshot(userKey);
      if (!snap) return;
      setOrgs(Array.isArray(snap.orgs) ? (snap.orgs as OrgRow[]) : []);
      setServerActiveOrgId(typeof snap.activeOrgId === "string" ? snap.activeOrgId : null);
    }

    window.addEventListener(ORGS_CACHE_UPDATED_EVENT, onCacheUpdated);
    return () => window.removeEventListener(ORGS_CACHE_UPDATED_EVENT, onCacheUpdated);
  }, [userKey]);

  return { session, userKey, orgsBusy, orgsError, orgs, stableOrgs, serverActiveOrgId, activeOrgId };
}

