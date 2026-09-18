"use client";

/**
 * Records that a recipient landed on `/p/:shareId`.
 *
 * Nothing on the project page used to be tracked at all: a sender could see that three documents
 * were opened and never that eleven people arrived and opened none. This posts once per tab session
 * to `POST /api/share/:shareId/landing`, which writes the `ProjectLinkView` row.
 *
 * Both identifiers are the ones the document viewer already uses, deliberately:
 * - `botId` from `localStorage` (`@/lib/botId`) — the same device identity `ShareView` is keyed on,
 *   so a landing and the reading that follows it belong to one person rather than two.
 * - `visitId` from `sessionStorage` under the **same key shape** `PdfJsViewer` uses
 *   (`lnkdrp_share_visit_session_v1:<shareId>`). Because a project link's `shareId` is one slug for
 *   the whole data room, the page and every document opened from it share one visit id: one tab
 *   session in the data room, however many documents it contains.
 *
 * Best-effort throughout. A recipient who blocks storage still sees the page; they are simply not
 * counted, which is the same bargain every other tracker in the product makes.
 */
import { useEffect } from "react";

import { getOrCreateBotId } from "@/lib/botId";

const SHARE_VISIT_SESSION_PREFIX = "lnkdrp_share_visit_session_v1:";
/** Matches `PdfJsViewer`: a tab left alone this long starts a new visit. */
const VISIT_IDLE_MS = 30 * 60 * 1000;

function randomHex(bytes: number): string {
  try {
    const a = new Uint8Array(bytes);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  }
}

/**
 * Read (or mint) this tab's visit id for a share slug.
 *
 * Intentionally a copy of `getOrCreateShareVisitId` in `PdfJsViewer` rather than an import: that
 * module is a ~3000-line client bundle with pdf.js behind it, and the project page must not pull it
 * in to record a landing. The two must agree on the key and the idle rule, which is why both are
 * named constants with the same values and this comment points at the other copy.
 */
function getOrCreateShareVisitId(shareId: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const key = `${SHARE_VISIT_SESSION_PREFIX}${shareId}`;
    const raw = window.sessionStorage.getItem(key);
    const now = Date.now();
    if (raw) {
      const parsed = JSON.parse(raw) as { visitId?: unknown; lastSeenAt?: unknown };
      const visitId = typeof parsed?.visitId === "string" ? parsed.visitId.trim() : "";
      if (visitId) {
        const last = typeof parsed.lastSeenAt === "number" && Number.isFinite(parsed.lastSeenAt) ? parsed.lastSeenAt : now;
        window.sessionStorage.setItem(key, JSON.stringify({ visitId, lastSeenAt: now }));
        if (now - last < VISIT_IDLE_MS) return visitId;
      }
    }
    const visitId = `v_${randomHex(16)}`;
    window.sessionStorage.setItem(key, JSON.stringify({ visitId, lastSeenAt: now }));
    return visitId;
  } catch {
    return null;
  }
}

export default function LandingBeacon({ shareId }: { shareId: string }) {
  useEffect(() => {
    const slug = shareId.trim();
    if (!slug) return;
    const botId = getOrCreateBotId();
    if (!botId) return;
    const visitId = getOrCreateShareVisitId(slug);
    // `keepalive`, like the viewer's timing flushes: a recipient who clicks straight through to a
    // document must still be counted as having arrived.
    void fetch(`/api/share/${encodeURIComponent(slug)}/landing`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botId, visitId }),
      keepalive: true,
    }).catch(() => {
      // Never surface an analytics failure to a recipient.
    });
  }, [shareId]);

  return null;
}
