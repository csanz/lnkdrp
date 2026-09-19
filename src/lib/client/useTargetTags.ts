/**
 * The tags on a list of things, for rows that print a dot each.
 *
 * One request for the whole list, refreshed when the list changes and when a tag changes anywhere
 * in the app (`lnkdrp:tags-changed`, the same event the sidebar's Tags section listens for). Rows
 * that have no tags simply have no entry — the caller renders nothing for them.
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { subscribeRealtime } from "@/lib/client/realtime";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import type { TagColorKey } from "@/lib/tags/palette";

export type RowTag = { id: string; name: string; slug: string; color: TagColorKey };

export function useTargetTags(targetKind: "doc" | "project", ids: readonly string[]): Record<string, RowTag[]> {
  const [byId, setById] = useState<Record<string, RowTag[]>>({});
  // A stable key, so a re-rendered array of the same ids does not refetch.
  const key = useMemo(() => [...ids].filter(Boolean).sort().join(","), [ids]);

  const load = useCallback(async () => {
    if (!key) {
      setById({});
      return;
    }
    try {
      const qs = new URLSearchParams({ targetKind, ids: key });
      const res = await fetchWithTempUser(`/api/tags/targets?${qs.toString()}`, { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as { tags?: Record<string, RowTag[]> };
      setById(json.tags && typeof json.tags === "object" ? json.tags : {});
    } catch {
      // The rows keep whatever they had; a dot is a hint, not the row's meaning.
    }
  }, [key, targetKind]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onChanged = () => void load();
    window.addEventListener("lnkdrp:tags-changed", onChanged);
    // And when someone else does the tagging — a teammate, or an agent through the MCP — the
    // workspace's realtime feed carries the row that says so.
    const unsubscribe = subscribeRealtime("activity", (frame) => {
      const type = frame.type === "activity" ? (frame.event?.type ?? "") : "";
      if (type.startsWith("tag.")) void load();
    });
    return () => {
      window.removeEventListener("lnkdrp:tags-changed", onChanged);
      unsubscribe();
    };
  }, [load]);

  return byId;
}
