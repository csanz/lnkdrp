/**
 * Route for `/org/switch`.
 *
 * Server-authoritative org switch:
 * - Validates the signed-in user is a member of the requested org
 * - Sets the active-org httpOnly cookie
 * - Redirects back to `returnTo` (defaults to `/`) so the app rehydrates in the new org context
 *   - Exception: if `returnTo` is a `/doc/:docId*` route and the doc does not belong to the target org,
 *     fall back to `/` to avoid landing on an unauthorized document page.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { UserModel } from "@/lib/models/User";
import { DocModel } from "@/lib/models/Doc";
import { resolveActor } from "@/lib/gating/actor";
import { ACTIVE_ORG_COOKIE } from "@/lib/orgs/activeOrgCookie";
import { LOADING_OVERLAY_TITLE_TO_DOTS_GAP_PX } from "@/lib/loadingOverlay";
import { LOADING_OVERLAY_SHOW_TEXT_DEFAULT } from "@/lib/loadingOverlay";

export const runtime = "nodejs";

/**
 * Normalizes a `returnTo` value into a safe same-origin path.
 *
 * Exists to prevent open redirects and protocol-relative navigation.
 */
function safeReturnTo(raw: string | null): string {
  const s = (raw ?? "").trim();
  if (!s) return "/";
  if (!s.startsWith("/")) return "/";
  // Prevent protocol-relative redirects.
  if (s.startsWith("//")) return "/";
  return s;
}

/**
 * Escapes a string for safe embedding in an HTML attribute.
 *
 * Exists because this route returns a small HTML page (not just JSON) in non-fetch flows.
 */
function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Extracts a doc id from a `/doc/:docId...` path (or returns null).
 *
 * Exists to prevent redirecting into a doc page that doesn't belong to the target org.
 */
function parseDocIdFromPath(path: string): string | null {
  const m = path.match(/^\/doc\/([a-f0-9]{24})(?:\/|$)/i);
  return m ? m[1] : null;
}

/**
 * `GET /org/switch`
 *
 * Server-authoritative workspace switch: validates membership, sets the active-org httpOnly cookie,
 * and returns either JSON (`json=1`) or a small HTML redirect page to ensure Set-Cookie persistence.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const orgId = url.searchParams.get("orgId")?.trim() ?? "";
  const returnTo = safeReturnTo(url.searchParams.get("returnTo"));
  const wantsJson = url.searchParams.get("json") === "1";

  const actor = await resolveActor(request);
  if (actor.kind !== "user") {
    return NextResponse.redirect(new URL("/", request.url));
  }

  if (!orgId || !Types.ObjectId.isValid(orgId)) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  await connectMongo();
  const targetOrgId = new Types.ObjectId(orgId);
  const ok = await OrgMembershipModel.exists({
    orgId: targetOrgId,
    userId: new Types.ObjectId(actor.userId),
    isDeleted: { $ne: true },
  });
  if (!ok) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  // Persist active org in Mongo (source of truth).
  await UserModel.updateOne(
    { _id: new Types.ObjectId(actor.userId) },
    { $set: { "metadata.activeOrgId": orgId, lastLoginAt: new Date() } },
  );

  // If the requested return target is a doc route, only allow it when the doc belongs to the target org.
  let redirectTo = returnTo;
  const docId = parseDocIdFromPath(returnTo);
  if (docId && Types.ObjectId.isValid(docId)) {
    const docOk = await DocModel.exists({
      _id: new Types.ObjectId(docId),
      orgId: targetOrgId,
      isDeleted: { $ne: true },
    });
    if (!docOk) redirectTo = "/";
  }

  // If the client is calling this route via `fetch()` (instead of full-page navigation),
  // return JSON so the caller can immediately navigate to the final target without ever
  // rendering a second "switching" page (prevents a visible style handoff).
  if (wantsJson) {
    const res = NextResponse.json(
      { redirectTo },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
    res.cookies.set(ACTIVE_ORG_COOKIE, orgId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
    return res;
  }

  // Use a 200 HTML response (instead of a redirect status) to ensure the browser persists
  // the Set-Cookie header reliably across clients.
  const hrefAttr = escapeHtmlAttr(redirectTo);
  const jsHref = JSON.stringify(redirectTo);
  const jsOrgId = JSON.stringify(orgId);
  const showTitle = LOADING_OVERLAY_SHOW_TEXT_DEFAULT;
  const res = new NextResponse(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <!-- Fallback redirect for no-JS environments. Keep this longer than the JS delay below. -->
    <meta http-equiv="refresh" content="4;url=${hrefAttr}" />
    <title>Switching workspace…</title>
    <script>
      // Lock the card position based on the initial viewport to avoid "jumping"
      // when mobile browser toolbars settle. Prefer the value from the client overlay
      // (so the handoff from "instant overlay" -> "/org/switch" looks identical).
      (function () {
        try {
          var raw = "";
          try {
            raw = (window.sessionStorage && sessionStorage.getItem("ld_ws_switch_overlay_y")) || "";
          } catch {}
          var parsed = raw ? parseInt(raw, 10) : NaN;
          var y = Number.isFinite(parsed) && parsed > 0 ? parsed : Math.round(window.innerHeight / 2);
          document.documentElement.style.setProperty("--ld_lock_y", y + "px");
        } catch {}
      })();

      // Pre-seed the next app boot with the target org id so client caches can immediately
      // scope themselves correctly (prevents cross-workspace flashes before /api/orgs/active resolves).
      (function () {
        try {
          (window.sessionStorage && sessionStorage.setItem("ld_pending_active_org_id", ${jsOrgId})) || void 0;
        } catch {}
      })();
    </script>
    <style>
      :root {
        --bg: #0b0b0c;
        --panel: #111113;
        --border: #2a2a31;
        --fg: #e7e7ea;
        --muted-2: #8b8b96;
      }
      @media (prefers-color-scheme: light) {
        :root {
          --bg: #fafafa;
          --panel: #ffffff;
          --border: rgba(0, 0, 0, 0.10);
          --fg: rgba(0, 0, 0, 0.90);
          --muted-2: rgba(0, 0, 0, 0.62);
        }
      }
      body {
        margin: 0;
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji",
          "Segoe UI Emoji";
        background: var(--bg);
        color: var(--fg);
      }
      .title {
        font-size: 17px;
        font-weight: 600;
        letter-spacing: -0.01em;
        text-align: center;
        opacity: 0.82;
      }
      .title[data-hidden="true"] {
        display: none;
      }
      .wrap {
        min-height: 100vh;
        min-height: 100svh;
        padding: 24px;
        display: flex;
        align-items: center;
        justify-content: center;
        box-sizing: border-box;
      }
      .stack {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: ${LOADING_OVERLAY_TITLE_TO_DOTS_GAP_PX}px;
        color: var(--fg);
        text-align: center;
      }
      @keyframes ldwsSpin {
        to {
          transform: rotate(360deg);
        }
      }
      .spinner {
        width: 28px;
        height: 28px;
        color: var(--fg);
        opacity: 0.85;
        animation: ldwsSpin 0.9s linear infinite;
      }
      .spinner svg {
        display: block;
        width: 100%;
        height: 100%;
      }
      a {
        color: inherit;
      }
      .noscript {
        margin-top: 10px;
        font-size: 12px;
        color: var(--muted-2);
        text-align: center;
      }
    </style>
  </head>
  <body>
    <div class="wrap" role="status" aria-live="polite">
      <div class="stack">
        <div class="title" data-hidden="${showTitle ? "false" : "true"}">${showTitle ? "Switching workspace…" : ""}</div>
        <div class="spinner" aria-hidden="true">
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" focusable="false">
            <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="3" opacity="0.25" />
            <path
              fill="currentColor"
              opacity="0.75"
              d="M12 3a9 9 0 0 1 9 9h-3a6 6 0 0 0-6-6V3z"
            />
          </svg>
        </div>
        <noscript>
          <div class="noscript">JavaScript is disabled. <a href="${hrefAttr}">Continue</a></div>
        </noscript>
      </div>
    </div>
    <script>
      // Add a small minimum delay so switching doesn't feel abrupt.
      window.setTimeout(function () {
        window.location.replace(${jsHref});
      }, 1400);
    </script>
  </body>
</html>`,
    {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    },
  );
  res.cookies.set(ACTIVE_ORG_COOKIE, orgId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return res;
}


