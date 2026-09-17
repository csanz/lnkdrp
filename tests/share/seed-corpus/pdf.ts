/**
 * Render the seed corpus to PDFs with `@napi-rs/canvas` (vector text, one page per spec page).
 *
 * Run: EMAIL_TRANSPORT=console npx tsx tests/share/seed-corpus/pdf.ts [--only <slug>]
 * Writes tests/share/.seed/pdf/{slug}.pdf and checks each page count with pdf-parse.
 */
import fs from "node:fs";
import path from "node:path";

import { PDFDocument } from "@napi-rs/canvas";
import pdfParse from "pdf-parse";

import { assertConsoleEmail, SEED_DIR } from "./api";
import { DOC_SPECS, SLIDE_TYPES, type DocSpec, type DocType, type PageSpec } from "./content";

export const PDF_DIR = path.join(SEED_DIR, "pdf");

type Palette = { bg: string; ink: string; muted: string; accent: string; banner: string };

const PALETTES: Record<DocType, Palette> = {
  pitch_deck: { bg: "#0f172a", ink: "#f8fafc", muted: "#94a3b8", accent: "#38bdf8", banner: "#1e293b" },
  investor_update: { bg: "#ffffff", ink: "#111827", muted: "#6b7280", accent: "#059669", banner: "#ecfdf5" },
  board_update: { bg: "#fafaf9", ink: "#1c1917", muted: "#78716c", accent: "#b45309", banner: "#fef3c7" },
  memo: { bg: "#ffffff", ink: "#1f2937", muted: "#6b7280", accent: "#4f46e5", banner: "#eef2ff" },
  proposal: { bg: "#ffffff", ink: "#0f172a", muted: "#64748b", accent: "#0d9488", banner: "#ccfbf1" },
  research_report: { bg: "#ffffff", ink: "#18181b", muted: "#71717a", accent: "#7c3aed", banner: "#f3e8ff" },
  pricing_proposal: { bg: "#ffffff", ink: "#111827", muted: "#6b7280", accent: "#dc2626", banner: "#fee2e2" },
  data_room_overview: { bg: "#f8fafc", ink: "#0f172a", muted: "#64748b", accent: "#2563eb", banner: "#dbeafe" },
  hiring_plan: { bg: "#ffffff", ink: "#1f2937", muted: "#6b7280", accent: "#db2777", banner: "#fce7f3" },
  security_whitepaper: { bg: "#ffffff", ink: "#0b1120", muted: "#475569", accent: "#16a34a", banner: "#dcfce7" },
  product_one_pager: { bg: "#111827", ink: "#f9fafb", muted: "#9ca3af", accent: "#f59e0b", banner: "#1f2937" },
};

const FONT = "Helvetica, Arial, sans-serif";

type Ctx = ReturnType<PDFDocument["beginPage"]>;

function wrap(ctx: Ctx, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawChart(ctx: Ctx, chart: NonNullable<PageSpec["chart"]>, x: number, y: number, w: number, h: number, pal: Palette) {
  const max = Math.max(...chart.values, 1);
  ctx.strokeStyle = pal.muted;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  ctx.lineTo(x + w, y + h);
  ctx.stroke();
  const n = chart.values.length;
  if (chart.kind === "bar") {
    const slot = w / n;
    chart.values.forEach((v, i) => {
      const bh = (v / max) * (h - 10);
      ctx.fillStyle = pal.accent;
      ctx.fillRect(x + i * slot + slot * 0.2, y + h - bh, slot * 0.6, bh);
    });
  } else {
    ctx.strokeStyle = pal.accent;
    ctx.lineWidth = 3;
    ctx.beginPath();
    chart.values.forEach((v, i) => {
      const px = x + (i / Math.max(1, n - 1)) * w;
      const py = y + h - (v / max) * (h - 10);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
  }
}

function drawPage(ctx: Ctx, spec: DocSpec, page: PageSpec, n: number, W: number, H: number) {
  const pal = PALETTES[spec.type];
  const slide = SLIDE_TYPES.has(spec.type);
  const margin = slide ? 64 : 54;
  ctx.fillStyle = pal.bg;
  ctx.fillRect(0, 0, W, H);

  const bannerH = slide ? 44 : 36;
  ctx.fillStyle = pal.banner;
  ctx.fillRect(0, 0, W, bannerH);
  ctx.fillStyle = pal.accent;
  ctx.fillRect(0, bannerH - 4, W, 4);
  ctx.fillStyle = pal.muted;
  ctx.font = `bold ${slide ? 16 : 12}px ${FONT}`;
  ctx.textBaseline = "middle";
  ctx.fillText(page.role.replace(/-/g, " ").toUpperCase(), margin, bannerH / 2 - 2);

  const isCover = page.role === "cover";
  const headingSize = isCover ? (slide ? 64 : 40) : slide ? 44 : 28;
  ctx.fillStyle = pal.ink;
  ctx.textBaseline = "alphabetic";
  ctx.font = `bold ${headingSize}px ${FONT}`;
  let y = isCover ? H * 0.38 : bannerH + margin + headingSize;
  for (const line of wrap(ctx, page.heading, W - margin * 2)) {
    ctx.fillText(line, margin, y);
    y += headingSize * 1.15;
  }

  const hasChart = Boolean(page.chart) && !isCover;
  const textWidth = hasChart && slide ? (W - margin * 2) * 0.52 : W - margin * 2;
  const bulletSize = slide ? 24 : 15;
  ctx.font = `${bulletSize}px ${FONT}`;
  y += bulletSize;
  const bulletTop = y;
  for (const b of page.bullets) {
    ctx.fillStyle = pal.accent;
    ctx.fillRect(margin, y - bulletSize * 0.45, bulletSize * 0.35, bulletSize * 0.35);
    ctx.fillStyle = isCover ? pal.muted : pal.ink;
    for (const line of wrap(ctx, b, textWidth - bulletSize)) {
      ctx.fillText(line, margin + bulletSize, y);
      y += bulletSize * 1.4;
    }
    y += bulletSize * 0.5;
  }

  if (hasChart && page.chart) {
    if (slide) {
      const cx = margin + textWidth + 40;
      drawChart(ctx, page.chart, cx, bulletTop - 10, W - cx - margin, H - bulletTop - 110, pal);
    } else {
      drawChart(ctx, page.chart, margin, y + 10, W - margin * 2, Math.min(220, H - y - 110), pal);
    }
  }

  const footY = H - (slide ? 28 : 26);
  ctx.fillStyle = pal.muted;
  ctx.font = `${slide ? 14 : 10}px ${FONT}`;
  ctx.fillText(spec.title, margin, footY);
  const counter = `${n} / ${spec.pages.length}`;
  ctx.fillText(counter, W - margin - ctx.measureText(counter).width, footY);
}

/** Render one spec to PDF bytes. */
export function renderSpecPdf(spec: DocSpec): Buffer {
  const slide = SLIDE_TYPES.has(spec.type);
  const W = slide ? 1280 : 612;
  const H = slide ? 720 : 792;
  const pdf = new PDFDocument({ title: spec.title, author: "lnkdrp seed corpus", creator: "lnkdrp-seed" });
  spec.pages.forEach((page, i) => {
    const ctx = pdf.beginPage(W, H);
    drawPage(ctx, spec, page, i + 1, W, H);
    pdf.endPage();
  });
  return pdf.close();
}

export async function pdfPageCount(bytes: Buffer): Promise<number> {
  const parsed = await pdfParse(bytes);
  return Number(parsed.numpages ?? 0);
}

/** Render (or reuse) a spec's PDF on disk and verify its page count. */
export async function ensureSpecPdf(spec: DocSpec, opts: { force?: boolean } = {}): Promise<{ file: string; bytes: Buffer }> {
  fs.mkdirSync(PDF_DIR, { recursive: true });
  const file = path.join(PDF_DIR, `${spec.slug}.pdf`);
  let bytes: Buffer | null = !opts.force && fs.existsSync(file) ? fs.readFileSync(file) : null;
  if (!bytes || (await pdfPageCount(bytes)) !== spec.pages.length) {
    const rendered = renderSpecPdf(spec);
    fs.writeFileSync(file, rendered);
    bytes = rendered;
  }
  const pages = await pdfPageCount(bytes);
  if (pages !== spec.pages.length) throw new Error(`${spec.slug}: pdf has ${pages} pages, spec has ${spec.pages.length}`);
  return { file, bytes };
}

async function main(): Promise<void> {
  assertConsoleEmail();
  const i = process.argv.indexOf("--only");
  const only = i !== -1 ? process.argv[i + 1] : null;
  const specs = only ? DOC_SPECS.filter((s) => s.slug === only) : DOC_SPECS;
  if (!specs.length) throw new Error(`no spec with slug ${only}`);
  let bytesTotal = 0;
  for (const spec of specs) {
    const { file, bytes } = await ensureSpecPdf(spec, { force: true });
    bytesTotal += bytes.length;
    console.log(`${String(spec.pages.length).padStart(2)} pages  ${(bytes.length / 1024).toFixed(0).padStart(5)} KB  ${path.relative(process.cwd(), file)}`);
  }
  console.log(`${specs.length} PDFs, ${(bytesTotal / 1024 / 1024).toFixed(1)} MB, page counts verified with pdf-parse.`);
}

if (/seed-corpus[\\/]pdf\.ts$/.test(process.argv[1] ?? "")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
