import { NextResponse } from "next/server";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { ShareViewModel } from "@/lib/models/ShareView";
import { shareAuthCookieName, shareAuthCookieValue } from "@/lib/sharePassword";
import crypto from "node:crypto";

export const runtime = "nodejs";
/**
 * Utc Day Key (uses slice, toISOString).
 */


function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}
/**
 * Pick First Forwarded Ip (uses trim, split).
 */


function pickFirstForwardedIp(v: string): string {
  return v.split(",")[0]?.trim() ?? "";
}
/**
 * Normalize Ip (uses trim, startsWith, includes).
 */


function normalizeIp(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (s.length > 128) return null;

  // Handle bracketed IPv6 like "[::1]:1234"
  if (s.startsWith("[") && s.includes("]")) {
    const inside = s.slice(1, s.indexOf("]")).trim();
    return inside || null;
  }

  // Strip port for "1.2.3.4:5678"
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(s)) {
    return s.slice(0, s.lastIndexOf(":"));
  }

  return s;
}
/**
 * Get client ip.
 */


function getClientIp(request: Request): string | null {
  const h = request.headers;
  const candidates = [
    h.get("cf-connecting-ip"),
    h.get("true-client-ip"),
    h.get("x-real-ip"),
    h.get("x-forwarded-for"),
    h.get("x-vercel-forwarded-for"),
  ];
  for (const c of candidates) {
    if (typeof c !== "string" || !c.trim()) continue;
    const first = c.includes(",") ? pickFirstForwardedIp(c) : c.trim();
    const ip = normalizeIp(first);
    if (ip) return ip;
  }
  return null;
}
/**
 * Get cookie.
 */


function getCookie(request: Request, name: string): string | null {
  const raw = request.headers.get("cookie");
  if (!raw) return null;
  // Minimal cookie parsing (no decoding needed for our values).
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=") || "";
  }
  return null;
}
/**
 * Pick Header (uses get, set).
 */


function pickHeader(src: Headers, dst: Headers, name: string, opts?: { fallback?: string }) {
  const v = src.get(name);
  if (typeof v === "string" && v) {
    dst.set(name, v);
    return;
  }
  if (opts?.fallback) dst.set(name, opts.fallback);
}
/**
 * Safe Pdf Filename (uses trim, toString, slice).
 */


function safePdfFilename(input: string | null | undefined): string {
  const base = (input ?? "").toString().trim() || "document";
  const cleaned = base
    .replace(/[\/\\?%*:|"<>]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  const withExt = cleaned.toLowerCase().endsWith(".pdf") ? cleaned : `${cleaned}.pdf`;
  return withExt || "document.pdf";
}

/**
 * Same-origin PDF proxy for `/s/:shareId`.
 *
 * - Supports Range requests (PDF.js uses them).
 * - If password-protected, requires the share auth cookie.
 * - If `?download=1`, enforces `doc.shareAllowPdfDownload` and sets attachment headers.
 */
export async function GET(request: Request, ctx: { params: Promise<{ shareId: string }> }) {
  const { shareId } = await ctx.params;
  if (!shareId) return NextResponse.json({ error: "Missing shareId" }, { status: 400 });

  const url = new URL(request.url);
  const wantsDownload = url.searchParams.get("download") === "1";
  const botId = url.searchParams.get("botId");
  const viewerIp = getClientIp(request);

  await connectMongo();
  const doc = await DocModel.findOne({ shareId, isDeleted: { $ne: true } })
    .select({
      _id: 1,
      blobUrl: 1,
      title: 1,
      fileName: 1,
      shareAllowPdfDownload: 1,
      shareEnabled: 1,
      sharePasswordHash: 1,
      sharePasswordSalt: 1,
    })
    .lean();

  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if ((doc as { shareEnabled?: unknown }).shareEnabled === false) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const blobUrl = (doc as { blobUrl?: unknown }).blobUrl;
  if (typeof blobUrl !== "string" || !blobUrl) {
    return NextResponse.json({ error: "PDF not available" }, { status: 404 });
  }

  const sharePasswordHash = (doc as { sharePasswordHash?: unknown }).sharePasswordHash;
  const sharePasswordSalt = (doc as { sharePasswordSalt?: unknown }).sharePasswordSalt;
  const passwordEnabled =
    typeof sharePasswordHash === "string" &&
    Boolean(sharePasswordHash) &&
    typeof sharePasswordSalt === "string" &&
    Boolean(sharePasswordSalt);

  if (passwordEnabled) {
    const cookieName = shareAuthCookieName(shareId);
    const cookie = getCookie(request, cookieName) ?? "";
    const expected = shareAuthCookieValue({ shareId, sharePasswordHash: sharePasswordHash as string });
    if (!cookie || cookie !== expected) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  if (wantsDownload && !Boolean((doc as { shareAllowPdfDownload?: unknown }).shareAllowPdfDownload)) {
    return new Response("Download disabled", { status: 403 });
  }

  // Best-effort download tracking (only when an explicit download is requested).
  if (wantsDownload && typeof botId === "string" && botId.trim()) {
    try {
      const botIdHash = crypto.createHash("sha256").update(botId.trim()).digest("hex");
      const docId = (doc as { _id: unknown })._id;
      const day = utcDayKey(new Date());
      await ShareViewModel.updateOne(
        { shareId, botIdHash },
        {
          $setOnInsert: {
            shareId,
            docId,
            botIdHash,
            pagesSeen: [],
          },
          ...(viewerIp ? { $set: { viewerIp } } : {}),
          $inc: { downloads: 1, [`downloadsByDay.${day}`]: 1 },
        },
        { upsert: true },
      );
    } catch (e) {
      // Ignore tracking failures (never block download).
      // If a duplicate key race occurs, retry once without upsert.
      try {
        const botIdHash = crypto.createHash("sha256").update(botId.trim()).digest("hex");
        const day = utcDayKey(new Date());
        await ShareViewModel.updateOne(
          { shareId, botIdHash },
          {
            ...(viewerIp ? { $set: { viewerIp } } : {}),
            $inc: { downloads: 1, [`downloadsByDay.${day}`]: 1 },
          },
        );
      } catch {
        // ignore
      }
      void e;
    }
  }

  const range = request.headers.get("range");
  const upstream = await fetch(blobUrl, {
    headers: range ? { range } : undefined,
    cache: "no-store",
  });

  const headers = new Headers();
  pickHeader(upstream.headers, headers, "content-type", { fallback: "application/pdf" });
  pickHeader(upstream.headers, headers, "content-length");
  pickHeader(upstream.headers, headers, "content-range");
  pickHeader(upstream.headers, headers, "accept-ranges");
  pickHeader(upstream.headers, headers, "etag");
  pickHeader(upstream.headers, headers, "last-modified");

  // Share pages can be password protected; keep caching private.
  headers.set("cache-control", "private, max-age=3600");

  const filename = safePdfFilename(
    (doc as { fileName?: unknown }).fileName as string | null | undefined ??
      ((doc as { title?: unknown }).title as string | null | undefined),
  );
  headers.set("content-disposition", `${wantsDownload ? "attachment" : "inline"}; filename="${filename}"`);

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}


