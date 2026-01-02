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
import { ACTIVE_ORG_COOKIE } from "@/app/api/orgs/active/route";

export const runtime = "nodejs";

function safeReturnTo(raw: string | null): string {
  const s = (raw ?? "").trim();
  if (!s) return "/";
  if (!s.startsWith("/")) return "/";
  // Prevent protocol-relative redirects.
  if (s.startsWith("//")) return "/";
  return s;
}

function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseDocIdFromPath(path: string): string | null {
  const m = path.match(/^\/doc\/([a-f0-9]{24})(?:\/|$)/i);
  return m ? m[1] : null;
}

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
      .wrap {
        min-height: 100vh;
        min-height: 100svh;
        padding: 40px 24px;
      }
      .card {
        width: min(760px, calc(100vw - 48px));
        position: fixed;
        left: 50%;
        top: var(--ld_lock_y, 50vh);
        transform: translate(-50%, -50%);
        border: 1px solid var(--border);
        background: var(--panel);
        color: var(--fg);
        border-radius: 28px;
        padding: 36px 36px 30px 36px;
        box-sizing: border-box;
        box-shadow: 0 18px 60px rgba(0,0,0,0.35);
      }
      .row {
        display: flex;
        align-items: center;
        gap: 14px;
      }
      .mark {
        width: 10px;
        height: 10px;
        border-radius: 999px;
        background: var(--fg);
        opacity: 0.75;
        flex: 0 0 auto;
      }
      .title {
        font-size: 18px;
        font-weight: 700;
        letter-spacing: -0.01em;
      }
      .sub {
        margin-top: 8px;
        font-size: 14px;
        color: var(--muted-2);
      }
      @keyframes lnkdrpIndeterminate {
        0% {
          transform: translateX(-120%);
        }
        100% {
          transform: translateX(320%);
        }
      }
      .progress {
        position: relative;
        margin-top: 24px;
        height: 3px;
        border-radius: 999px;
        background: color-mix(in srgb, var(--fg) 14%, transparent);
        overflow: hidden;
      }
      .progress > div {
        position: absolute;
        inset: 0 auto 0 0;
        width: 34%;
        background: var(--fg);
        opacity: 0.55;
        animation: lnkdrpIndeterminate 1.15s ease-in-out infinite;
      }
      a {
        color: inherit;
      }
      .noscript {
        margin-top: 10px;
        font-size: 12px;
        color: var(--muted-2);
      }
    </style>
  </head>
  <body>
    <div class="wrap" role="status" aria-live="polite">
      <div class="card">
        <div class="row">
          <div class="mark" aria-hidden="true"></div>
          <div>
            <div class="title">Switching workspace…</div>
            <div class="sub">Just a moment.</div>
          </div>
        </div>
        <div class="progress" aria-hidden="true"><div></div></div>
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


