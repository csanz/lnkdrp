/**
 * SwitchingOverlay
 *
 * A small, brand-aligned "Switching…" overlay used for workspace switches (and reusable for other
 * short transition states). Implemented as an imperative DOM overlay so it can show instantly
 * before navigation begins.
 */
import { LOADING_OVERLAY_TITLE_TO_DOTS_GAP_PX } from "@/lib/loadingOverlay";
import { LOADING_OVERLAY_SHOW_TEXT_DEFAULT } from "@/lib/loadingOverlay";

export const SWITCHING_OVERLAY_ID = "ld_workspace_switch_overlay";
export const DOC_NAV_OVERLAY_ID = "ld_doc_nav_overlay";
export const PROJECT_NAV_OVERLAY_ID = "ld_project_nav_overlay";
export const UPLOAD_NAV_OVERLAY_ID = "ld_upload_nav_overlay";
export const SWITCHING_OVERLAY_Y_KEY = "ld_ws_switch_overlay_y";
export const SWITCHING_OVERLAY_STARTED_AT_KEY = "ld_ws_switch_started_at";
// Used to pre-seed client cache scoping on the *next* page load after switching.
// Important: do NOT write `lnkdrp-active-org-id` from the old workspace page, because
// sidebar/starred effects may fetch using the old httpOnly cookie and pollute the new-org keys.
export const PENDING_ACTIVE_ORG_ID_KEY = "ld_pending_active_org_id";

export const DEFAULT_SWITCHING_OVERLAY_MIN_MS = 1400;

export type SwitchingOverlayOptions = {
  id?: string;
  title?: string | null;
  showTitle?: boolean;
  subtitle?: string;
  /**
   * Minimum time the overlay should remain visible before the caller navigates.
   * This is enforced via `waitForMinOverlayTime()`.
   */
  minMs?: number;
};

function safeNow() {
  return typeof Date !== "undefined" ? Date.now() : 0;
}

/**
 * Imperatively mounts a full-screen "Switching…" overlay into the DOM (best-effort).
 *
 * Exists so navigation-sensitive actions (like workspace switching) can show immediate feedback
 * before route transitions begin. Side effects: writes timing/position hints to sessionStorage.
 */
export function showSwitchingOverlay(opts: SwitchingOverlayOptions = {}) {
  if (typeof document === "undefined") return;
  const id = opts.id ?? SWITCHING_OVERLAY_ID;
  try {
    if (document.getElementById(id)) return;

    const showTitle = typeof opts.showTitle === "boolean" ? opts.showTitle : LOADING_OVERLAY_SHOW_TEXT_DEFAULT;
    const rawTitle = typeof opts.title === "string" ? opts.title : opts.title === null ? "" : "Switching workspace…";
    const title = rawTitle.trim();

    try {
      const yPx = typeof window !== "undefined" ? Math.round(window.innerHeight / 2) : 0;
      sessionStorage.setItem(SWITCHING_OVERLAY_Y_KEY, String(yPx));
      sessionStorage.setItem(SWITCHING_OVERLAY_STARTED_AT_KEY, String(safeNow()));
    } catch {
      // ignore
    }

    const root = document.createElement("div");
    root.id = id;
    root.setAttribute("role", "status");
    root.setAttribute("aria-live", "polite");
    root.style.position = "fixed";
    root.style.inset = "0";
    root.style.zIndex = "2147483647";
    // Fully opaque so underlying UI doesn't peek through during navigation.
    root.style.background = "var(--bg, #0b0b0c)";

    // NOTE: Keep this markup/CSS in sync with the /org/switch fallback.
    root.innerHTML = `
      <style>
        .ldws-wrap {
          min-height: 100vh;
          min-height: 100svh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
          box-sizing: border-box;
        }
        .ldws-stack {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: ${LOADING_OVERLAY_TITLE_TO_DOTS_GAP_PX}px;
          color: var(--fg, #e7e7ea);
          text-align: center;
        }
        .ldws-title { font-size: 17px; font-weight: 600; letter-spacing: -0.01em; opacity: 0.82; }
        .ldws-title[data-hidden="true"] { display: none; }
        @keyframes ldwsSpin { to { transform: rotate(360deg); } }
        .ldws-spinner {
          width: 28px;
          height: 28px;
          color: var(--fg, #e7e7ea);
          opacity: 0.85;
          animation: ldwsSpin 0.9s linear infinite;
        }
        .ldws-spinner svg { display: block; width: 100%; height: 100%; }
      </style>
      <div class="ldws-wrap">
        <div class="ldws-stack">
          <div class="ldws-title" data-hidden="false"></div>
          <div class="ldws-spinner" aria-hidden="true">
            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" focusable="false">
              <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="3" opacity="0.25" />
              <path
                fill="currentColor"
                opacity="0.75"
                d="M12 3a9 9 0 0 1 9 9h-3a6 6 0 0 0-6-6V3z"
              />
            </svg>
          </div>
        </div>
      </div>
    `;

    // Fill text via DOM APIs to avoid HTML injection.
    document.body.appendChild(root);
    const titleEl = root.querySelector(".ldws-title");
    if (titleEl) {
      const shouldShow = showTitle && Boolean(title);
      titleEl.setAttribute("data-hidden", shouldShow ? "false" : "true");
      titleEl.textContent = shouldShow ? title : "";
    }
  } catch {
    // ignore (best-effort)
  }
}

/**
 * Removes a previously mounted overlay by id (best-effort).
 *
 * Exists to clean up imperative overlays after navigation completes or is cancelled.
 */
export function hideSwitchingOverlay(id = SWITCHING_OVERLAY_ID) {
  if (typeof document === "undefined") return;
  try {
    const el = document.getElementById(id);
    if (el?.parentNode) el.parentNode.removeChild(el);
  } catch {
    // ignore (best-effort)
  }
}

/**
 * Waits for the next paint (or a short timeout) to allow the overlay to render before navigating.
 *
 * Returns a promise that resolves after `ms` in the browser; resolves immediately on the server.
 */
export function waitForNextPaint(ms = 60) {
  return new Promise<void>((resolve) => (typeof window !== "undefined" ? window.setTimeout(resolve, ms) : resolve()));
}

/**
 * Ensures the overlay has been visible for at least `minMs` before proceeding (best-effort).
 *
 * Exists to avoid UI flicker on very fast switches by enforcing a minimum perceived duration.
 */
export async function waitForMinOverlayTime(minMs = DEFAULT_SWITCHING_OVERLAY_MIN_MS) {
  if (typeof window === "undefined") return;
  try {
    const raw = sessionStorage.getItem(SWITCHING_OVERLAY_STARTED_AT_KEY) ?? "";
    const startedAt = raw ? parseInt(raw, 10) : NaN;
    const elapsed = Number.isFinite(startedAt) ? safeNow() - startedAt : 0;
    const remaining = minMs - elapsed;
    if (remaining > 0) await new Promise<void>((resolve) => window.setTimeout(resolve, remaining));
  } catch {
    // ignore
  }
}

/**
 * Calls the `/org/switch` endpoint to set the active-org cookie and returns the redirect URL.
 *
 * Side effects: on success, stores the target org id in sessionStorage so the next app boot can
 * immediately scope client caches and avoid cross-workspace flashes.
 */
export async function fetchOrgSwitchRedirectTo(opts: { orgId: string; returnTo: string }) {
  const { orgId, returnTo } = opts;
  const url = `/org/switch?orgId=${encodeURIComponent(orgId)}&returnTo=${encodeURIComponent(returnTo)}&json=1`;
  const res = await fetch(url, { method: "GET", credentials: "include", cache: "no-store" });
  const json = (await res.json().catch(() => null)) as { redirectTo?: unknown } | null;
  // If the server accepted the switch (and set the cookie), store the target org id in sessionStorage
  // so the next app boot can scope caches immediately and avoid cross-workspace flashes.
  const accepted = res.ok && typeof json?.redirectTo === "string" && json.redirectTo;
  if (accepted) {
    try {
      sessionStorage.setItem(PENDING_ACTIVE_ORG_ID_KEY, orgId);
    } catch {
      // ignore (best-effort)
    }
  }
  return typeof json?.redirectTo === "string" && json.redirectTo ? json.redirectTo : returnTo || "/";
}

/**
 * Shows the overlay, switches workspace via `/org/switch`, then navigates to the returned URL.
 *
 * Exists to make workspace switching feel deliberate and to avoid "flash of wrong workspace" while
 * cookies and caches settle. Side effects: uses `window.location.assign` to perform navigation.
 */
export async function switchWorkspaceWithOverlay(opts: { orgId: string; returnTo: string } & SwitchingOverlayOptions) {
  if (typeof window === "undefined") return;
  const minMs = typeof opts.minMs === "number" ? opts.minMs : DEFAULT_SWITCHING_OVERLAY_MIN_MS;
  showSwitchingOverlay({ title: opts.title, subtitle: opts.subtitle, id: opts.id, minMs });
  await waitForNextPaint();
  const redirectTo = await fetchOrgSwitchRedirectTo({ orgId: opts.orgId, returnTo: opts.returnTo });
  await waitForMinOverlayTime(minMs);
  window.location.assign(redirectTo);
}


