/**
 * SwitchingOverlay
 *
 * A small, brand-aligned "Switching…" overlay used for workspace switches (and reusable for other
 * short transition states). Implemented as an imperative DOM overlay so it can show instantly
 * before navigation begins.
 */
export const SWITCHING_OVERLAY_ID = "ld_workspace_switch_overlay";
export const DOC_NAV_OVERLAY_ID = "ld_doc_nav_overlay";
export const PROJECT_NAV_OVERLAY_ID = "ld_project_nav_overlay";
export const SWITCHING_OVERLAY_Y_KEY = "ld_ws_switch_overlay_y";
export const SWITCHING_OVERLAY_STARTED_AT_KEY = "ld_ws_switch_started_at";
// Used to pre-seed client cache scoping on the *next* page load after switching.
// Important: do NOT write `lnkdrp-active-org-id` from the old workspace page, because
// sidebar/starred effects may fetch using the old httpOnly cookie and pollute the new-org keys.
export const PENDING_ACTIVE_ORG_ID_KEY = "ld_pending_active_org_id";

export const DEFAULT_SWITCHING_OVERLAY_MIN_MS = 1400;

export type SwitchingOverlayOptions = {
  id?: string;
  title?: string;
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

    const yPx = typeof window !== "undefined" ? Math.round(window.innerHeight / 2) : 0;
    const title = (opts.title ?? "Switching workspace…").trim() || "Switching…";
    const subtitle = (opts.subtitle ?? "Just a moment.").trim() || "Just a moment.";

    try {
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
        @keyframes lnkdrpIndeterminate { 0% { transform: translateX(-120%); } 100% { transform: translateX(320%); } }
        .ldws-card {
          width: min(760px, calc(100vw - 48px));
          position: fixed;
          left: 50%;
          top: ${yPx || 0}px;
          transform: translate(-50%, -50%);
          border: 1px solid var(--border, #2a2a31);
          background: var(--panel, #111113);
          color: var(--fg, #e7e7ea);
          border-radius: 28px;
          padding: 36px 36px 30px 36px;
          box-sizing: border-box;
          box-shadow: 0 18px 60px rgba(0,0,0,0.35);
        }
        .ldws-row { display: flex; align-items: center; gap: 14px; }
        .ldws-mark {
          width: 10px; height: 10px; border-radius: 999px;
          background: var(--fg, #e7e7ea);
          opacity: 0.75;
          flex: 0 0 auto;
        }
        .ldws-title { font-size: 18px; font-weight: 700; letter-spacing: -0.01em; }
        .ldws-sub { margin-top: 8px; font-size: 14px; color: var(--muted-2, #8b8b96); }
        .ldws-progress {
          position: relative;
          margin-top: 24px;
          height: 3px;
          border-radius: 999px;
          background: color-mix(in srgb, var(--fg, #e7e7ea) 14%, transparent);
          overflow: hidden;
        }
        .ldws-progress > div {
          position: absolute;
          inset: 0 auto 0 0;
          width: 34%;
          background: var(--fg, #e7e7ea);
          opacity: 0.55;
          animation: lnkdrpIndeterminate 1.15s ease-in-out infinite;
        }
      </style>
      <div class="ldws-card">
        <div class="ldws-row">
          <div class="ldws-mark" aria-hidden="true"></div>
          <div>
            <div class="ldws-title"></div>
            <div class="ldws-sub"></div>
          </div>
        </div>
        <div class="ldws-progress" aria-hidden="true"><div></div></div>
      </div>
    `;

    // Fill text via DOM APIs to avoid HTML injection.
    document.body.appendChild(root);
    const titleEl = root.querySelector(".ldws-title");
    const subEl = root.querySelector(".ldws-sub");
    if (titleEl) titleEl.textContent = title;
    if (subEl) subEl.textContent = subtitle;
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


