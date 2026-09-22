"use client";

/**
 * Compute the changed regions of a page pair in the viewer's own browser.
 *
 * Both renders are already downloaded to show the comparison, and the blob host sends
 * `access-control-allow-origin: *`, so the canvas can read their pixels. That is the whole reason
 * this is cheap enough to do at all: the same work on the server would mean re-fetching both JPEGs
 * per changed page, decoding them, storing rectangles and migrating a schema, for a result the
 * client can reach in a few milliseconds on pixels it already holds. Nothing here costs a model
 * call, a blob or a database write.
 *
 * `crossOrigin="anonymous"` is required on the load or `getImageData` throws a SecurityError on a
 * tainted canvas. A failure of any kind resolves to null and the overlay simply does not appear -
 * highlights are an aid, never a precondition for seeing the two pages.
 */
import { useEffect, useState } from "react";

import { diffRegions, type DiffRegions } from "@/lib/history/pageDiffRegions";

/**
 * Width both pages are scaled to before comparing.
 *
 * Fixed so the cell grid means the same thing whatever the source rendition, and small enough that
 * the whole comparison is a few milliseconds of work on a 640-wide bitmap rather than a 1200-wide
 * one. Detail below this scale is not something a box could usefully point at anyway.
 */
const ANALYSIS_WIDTH = 640;

/** Load an image with CORS enabled, which is what makes the canvas pixels readable. */
function load(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image load failed"));
    img.src = url;
  });
}

/**
 * Both pages drawn onto one canvas size, letterboxed rather than stretched.
 *
 * A page whose box changed between versions has a different aspect ratio, and stretching it to
 * match would move every pixel on it and report the entire page as changed. Fitting it inside a
 * common frame on white keeps the comparison meaningful and confines the difference to the bands
 * where one version genuinely has no page.
 */
function rasterize(img: HTMLImageElement, width: number, height: number): Uint8ClampedArray | null {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  const scale = Math.min(width / img.naturalWidth, height / img.naturalHeight);
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  ctx.drawImage(img, Math.floor((width - w) / 2), Math.floor((height - h) / 2), w, h);
  try {
    return ctx.getImageData(0, 0, width, height).data;
  } catch {
    // Tainted canvas: the host did not allow the read after all.
    return null;
  }
}

export type DiffState = { status: "idle" | "working" } | ({ status: "done" } & DiffRegions) | { status: "unavailable" };

/** Changed regions for one page pair, recomputed whenever the pair changes. */
export function useDiffRegions(previousUrl: string | null, newUrl: string | null, enabled: boolean): DiffState {
  const [state, setState] = useState<DiffState>({ status: "idle" });

  useEffect(() => {
    if (!enabled || !previousUrl || !newUrl) {
      setState({ status: "idle" });
      return;
    }
    let cancelled = false;
    setState({ status: "working" });
    (async () => {
      try {
        const [a, b] = await Promise.all([load(previousUrl), load(newUrl)]);
        if (cancelled) return;
        /**
         * The frame takes the NEW page's aspect ratio, and the previous page is letterboxed into
         * it. That choice is what lets a box be drawn straight onto the new render with no
         * remapping: the analysis frame and that image are the same shape, so a box at 40% across
         * is at 40% across. The two pages are almost always the same size anyway; when they are
         * not, the letterbox bands read as changed, which is true - one version has no page there.
         */
        const ratio = b.naturalHeight / b.naturalWidth;
        const height = Math.max(8, Math.round(ANALYSIS_WIDTH * (Number.isFinite(ratio) && ratio > 0 ? ratio : 1)));
        const prev = rasterize(a, ANALYSIS_WIDTH, height);
        const next = rasterize(b, ANALYSIS_WIDTH, height);
        if (cancelled) return;
        if (!prev || !next) return setState({ status: "unavailable" });
        const result = diffRegions(prev, next, ANALYSIS_WIDTH, height);
        if (cancelled) return;
        setState(result ? { status: "done", ...result } : { status: "unavailable" });
      } catch {
        if (!cancelled) setState({ status: "unavailable" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [previousUrl, newUrl, enabled]);

  return state;
}
