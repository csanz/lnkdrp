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
import { activeOrgChanged } from "@/lib/gating/actor";
import { jsonForScript } from "@/lib/http/jsonForScript";

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
  /**
   * Same-origin only, decided by the URL parser rather than by prefix tests.
   *
   * The prefix tests missed `/\evil.example`: a backslash in that position is normalised to a
   * slash by browsers, so the value reads as protocol-relative and the workspace switcher would
   * bounce the signed-in user straight off the origin — a credible phishing hop, since it happens
   * right after an auth action they initiated.
   */
  try {
    const parsed = new URL(s, "https://lnkdrp.invalid");
    if (parsed.origin !== "https://lnkdrp.invalid") return "/";
    const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    return path.startsWith("/") ? path : "/";
  } catch {
    return "/";
  }
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
 * True when this workspace switch is one the app itself started.
 *
 * `GET /org/switch` is side-effecting: it writes `metadata.activeOrgId` onto the user record and
 * sets a year-long active-org cookie. A side-effecting GET with no CSRF token, reached with a
 * `SameSite=Lax` session cookie that rides along on top-level navigations, is exactly the shape a
 * link exploits — send a colleague `/org/switch?orgId=<a team they are genuinely in>` and their
 * active workspace flips under them without them ever choosing to switch. Membership is validated,
 * so it succeeds silently, and because the active org is persisted on the user record it outlives
 * the tab and follows them to their other devices. The next document they upload lands in that
 * other workspace.
 *
 * `Sec-Fetch-Site` is stamped by the browser and cannot be set from page script, so it is the one
 * signal in this handler that separates the app's own navigation from a link somebody sent. Every
 * caller in this product navigates (or `fetch`es) from a page already on this origin —
 * `SwitchingOverlay`, both `WorkspaceManager`s, `AccountMenu`, the upload page, the join page — so
 * a genuine switch always reports `same-origin`, or `same-site` if the app is ever served from a
 * sibling subdomain. `cross-site` is a foreign page. `none` is an address bar, a bookmark, or a
 * link opened out of a native mail or chat client, which is the finding's delivery route and is
 * never something this product generates.
 *
 * A request carrying no Fetch Metadata at all is honoured, deliberately. Browsers that predate the
 * headers omit them, and refusing those would break the workspace switcher outright for real people
 * in order to inconvenience a client that can simply choose to send whichever header it likes. This
 * raises the bar on the everyday "click this link" version; it is not a CSRF token.
 */
function isAppInitiatedSwitch(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (!site) return true;
  return site === "same-origin" || site === "same-site";
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

  // A switch nobody in the app asked for is not a switch. Degrade rather than refuse: send them to
  // the app in the workspace they are already in — the same answer every other rejected input here
  // gets — instead of showing an error for a link they were probably just curious about.
  if (!isAppInitiatedSwitch(request)) {
    return NextResponse.redirect(new URL("/", request.url));
  }

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
  // The resolvers cache this value for a minute, so the switch has to say it moved. In this
  // browser the cookie set alongside it wins anyway; on the person's *other* device the metadata
  // is the only signal, and without this the switch would look like it had not taken.
  activeOrgChanged(actor.userId);

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
  const jsHref = jsonForScript(redirectTo);
  const jsOrgId = jsonForScript(orgId);
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
    <script>
      // This overlay is a standalone document, so next-themes is not here to stamp the theme for it.
      // It used to theme off prefers-color-scheme alone, which meant a user on a dark OS who had
      // explicitly chosen Light got a near-black full-viewport flash mid-navigation and then landed
      // back on a light app: the exact bug the @custom-variant at the top of globals.css exists to
      // prevent. Read the same stored choice next-themes writes and stamp it ourselves.
      (function () {
        try {
          var t = window.localStorage && localStorage.getItem("theme");
          if (t === "dark" || t === "light") document.documentElement.setAttribute("data-theme", t);
        } catch {}
      })();
    </script>
    <style>
      /* Light is the bare :root default and dark is the override, mirroring globals.css, and the
         five values below are the app's real tokens, so the overlay matches the screens it sits
         between instead of approximating them. */
      :root {
        color-scheme: light;
        --bg: #f9f9fa;
        --panel: #ffffff;
        --border: #d6d6dc;
        --fg: #1c1c20;
        --muted-2: #5b5b64;
      }
      :root[data-theme="dark"] {
        color-scheme: dark;
        --bg: #0b0b0c;
        --panel: #111113;
        --border: #2a2a31;
        --fg: #e7e7ea;
        --muted-2: #8b8b96;
      }
      @media (prefers-color-scheme: dark) {
        :root:not([data-theme]) {
          color-scheme: dark;
          --bg: #0b0b0c;
          --panel: #111113;
          --border: #2a2a31;
          --fg: #e7e7ea;
          --muted-2: #8b8b96;
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


