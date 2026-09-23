/**
 * The homepage product shot for visit briefs: three brief emails in one frame.
 *
 * Regenerated, never hand-cropped (the rule every home shot follows): this composes the emails
 * with the real `composeVisitBriefEmail`, lays them out in a dark frame the size of the other
 * shots, and captures it with headless Chrome at 2x. Run it again whenever the email changes.
 *
 * Everyone in it is invented — Marcus Feld, Priya Natarajan, Fernhill Foods, Dunmore Recruiting,
 * Kestrel Row, Northwind — because these end up legible at full size on a public page.
 *
 *   npx tsx scripts/home-shot-brief.ts
 *   → public/images/home/brief.png (3640×2120)
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { composeVisitBriefEmail, type VisitBriefEntry } from "@/lib/notifications/visitBriefEmail";

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = path.resolve(process.cwd(), "public/images/home/brief.png");
const WORK = path.resolve(process.cwd(), "tmp/home-shot-brief");
/** The frame the other shots use, at 1x; captured at 2x. */
const WIDTH = 1820;
const HEIGHT = 1060;

const base = {
  linkLabel: "Kestrel Row",
  audience: "Kestrel Row · growth team",
  docsOpened: [] as string[],
  pageCount: 13,
  skipped: [] as string[],
  recapLine: null,
  url: "https://lnkdrp.com/doc/x/metrics",
  docUrl: "https://lnkdrp.com/doc/x",
};

const ENTRIES: VisitBriefEntry[] = [
  {
    ...base,
    viewerLabel: "Marcus Feld",
    title: "Fernhill Foods pitch deck",
    startedAt: new Date("2026-09-23T15:35:00Z"),
    endedAt: new Date("2026-09-23T15:40:08Z"),
    timeSpentMs: 5 * 60_000 + 8_000,
    pagesSeen: 6,
    downloads: 1,
    visitNumber: 1,
    lastVisitMs: null,
    lastVisitAt: null,
    topPages: [
      { page: 8, heading: "Pricing", ms: 118_000, opened: 2 },
      { page: 4, heading: "Product", ms: 61_000, opened: 3 },
      { page: 5, heading: "Market", ms: 41_000, opened: 2 },
      { page: 1, heading: null, ms: 33_000, opened: 2 },
    ],
    path: [1, 3, 4, 3, 4, 5, 8, 1, 4, 8, 10, 5],
    skipped: ["2", "6–7", "9", "11–13"],
    brief: {
      headline: "spent 2 min on the Growth, Starter and Enterprise pricing tiers, then downloaded the pitch deck",
      body: "Marcus spent about 2 minutes on the pricing page, which sets out the Growth, Starter and Enterprise tiers, and came back to it twice. He also returned to the product page — customer numbers and the 2,300 ms median response time — and to the market page's $16.4B spend figure. After that he downloaded the deck.",
      interests: [
        "Growth, Starter and Enterprise pricing tiers (p. 8) — 2 min, opened twice; likely weighing cost",
        "Customer numbers and the 2,300 ms response time (p. 4) — 61 s, opened three times; likely checking traction",
        "$16.4B market spend and 49% growth (p. 5) — 41 s, opened twice; likely sizing the opportunity",
      ],
      highlights: ["Returned to the product page three times", "Downloaded the pitch deck", "Skipped the team and financials pages"],
      followUp: "Lead with pricing; he has already read the tiers twice.",
    },
  },
  {
    ...base,
    viewerLabel: "Marcus Feld",
    title: "Fernhill Foods pitch deck",
    startedAt: new Date("2026-09-24T09:12:00Z"),
    endedAt: new Date("2026-09-24T09:17:12Z"),
    timeSpentMs: 5 * 60_000 + 12_000,
    pagesSeen: 9,
    downloads: 0,
    visitNumber: 2,
    lastVisitMs: 5 * 60_000 + 8_000,
    lastVisitAt: new Date("2026-09-23T15:35:00Z"),
    topPages: [
      { page: 3, heading: "Solution", ms: 117_000, opened: 2 },
      { page: 12, heading: "Financials", ms: 35_000, opened: 1 },
      { page: 10, heading: "Team", ms: 32_000, opened: 1 },
      { page: 6, heading: "Traction", ms: 16_000, opened: 2 },
    ],
    path: [1, 3, 5, 6, 3, 6, 9, 10, 11, 12, 13],
    skipped: ["2", "4", "7–8"],
    brief: {
      headline: "came back and spent 2 min on the 56% manual-step reduction claim",
      body: "Second visit, a day after the first. Marcus went straight to the solution page — the 56% reduction in manual steps and pricing per outcome — and read it twice. He then went through the traction, team and financials pages he had not opened before, and skipped pricing this time, which held him longest last visit.",
      interests: [
        "56% reduction in manual steps and pricing per outcome (p. 3) — 2 min, opened twice; likely testing the efficiency claim",
        "334 paying customers and 57% net retention (p. 6) — opened twice; likely checking the growth numbers",
      ],
      highlights: ["Read the financials for the first time", "Skipped pricing this visit", "No download this time"],
      followUp: "He is past pricing and on to proof. Send the customer references.",
    },
  },
  {
    ...base,
    viewerLabel: "Priya Natarajan",
    linkLabel: "Northwind",
    audience: "Northwind Partners",
    title: "Dunmore Recruiting security whitepaper",
    pageCount: 11,
    startedAt: new Date("2026-09-23T19:33:00Z"),
    endedAt: new Date("2026-09-23T19:38:39Z"),
    timeSpentMs: 5 * 60_000 + 39_000,
    pagesSeen: 7,
    downloads: 1,
    visitNumber: 1,
    lastVisitMs: null,
    lastVisitAt: null,
    topPages: [
      { page: 6, heading: "Network security", ms: 117_000, opened: 2 },
      { page: 5, heading: "Vendor management", ms: 109_000, opened: 2 },
      { page: 3, heading: "Architecture", ms: 35_000, opened: 2 },
    ],
    path: [1, 3, 1, 3, 5, 6, 8, 6, 7, 10, 5],
    skipped: ["2", "4", "9", "11"],
    brief: {
      headline: "spent 2 min on DDoS protection and the WAF, then downloaded the whitepaper",
      body: "Priya spent the most time on the network security page — WAF and DDoS protection, segmented environments, continuous vulnerability scanning — and came back to it. She also returned to vendor management: the sub-processor list, breach-notice terms and the annual reassessment. Encryption and incident response were skipped. She downloaded the document before leaving.",
      interests: [
        "WAF, DDoS protection and segmented environments (p. 6) — 2 min, opened twice; likely assessing the perimeter",
        "Sub-processor list and breach-notice terms (p. 5) — 2 min, opened twice; likely checking vendor exposure",
      ],
      highlights: ["Returned to vendor management twice", "Downloaded the whitepaper", "Skipped encryption and incident response"],
      followUp: "Offer the pen-test summary; she read the perimeter pages closely.",
    },
  },
];

function emailHtml(entry: VisitBriefEntry): string {
  const mail = composeVisitBriefEmail({
    entries: [entry],
    daily: false,
    workspace: { name: "Fernhill", avatarUrl: null },
    offUrl: "https://lnkdrp.com/off",
    preferencesUrl: "https://lnkdrp.com/dashboard?tab=notifications",
    turnOffLabel: "Turn off these emails",
    changeHowOftenLabel: "Change how often",
    metricsUrl: null,
  });
  // The card on its own: the grey mail-client backdrop and its padding are the frame's job here.
  return mail.html.replace(/background:#f4f4f5;?/g, "background:transparent;").replace(/padding:24px 12px;/g, "padding:0;");
}

function main(): void {
  mkdirSync(WORK, { recursive: true });
  mkdirSync(path.dirname(OUT), { recursive: true });
  const files = ENTRIES.map((entry, i) => {
    const file = path.join(WORK, `email-${i + 1}.html`);
    writeFileSync(file, emailHtml(entry));
    return file;
  });

  // Three cards, the middle one lifted, all cut at the frame's foot behind a fade — the frame is
  // the shape of the other shots, and a brief is taller than that on purpose.
  const page = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden;background:#09090b;}
    .frame{position:relative;width:${WIDTH}px;height:${HEIGHT}px;
      background:
        radial-gradient(900px 520px at 50% -10%, rgba(255,255,255,0.10), transparent 70%),
        linear-gradient(180deg,#0f0f11 0%,#09090b 100%);}
    .cards{position:absolute;left:38px;top:56px;display:flex;gap:32px;align-items:flex-start;}
    .card{width:560px;height:${HEIGHT}px;border:0;background:transparent;display:block;
      filter:drop-shadow(0 30px 60px rgba(0,0,0,0.6));}
    .card.mid{margin-top:-28px;}
    .fade{position:absolute;left:0;right:0;bottom:0;height:220px;
      background:linear-gradient(180deg,rgba(9,9,11,0) 0%,rgba(9,9,11,0.85) 60%,#09090b 100%);}
  </style></head><body><div class="frame">
    <div class="cards">
      <iframe class="card" src="file://${files[0]}" scrolling="no"></iframe>
      <iframe class="card mid" src="file://${files[1]}" scrolling="no"></iframe>
      <iframe class="card" src="file://${files[2]}" scrolling="no"></iframe>
    </div>
    <div class="fade"></div>
  </div></body></html>`;
  const pageFile = path.join(WORK, "frame.html");
  writeFileSync(pageFile, page);

  execFileSync(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=2",
      `--window-size=${WIDTH},${HEIGHT}`,
      "--virtual-time-budget=3000",
      `--screenshot=${OUT}`,
      `file://${pageFile}`,
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  // eslint-disable-next-line no-console
  console.log(`wrote ${OUT} (${WIDTH * 2}×${HEIGHT * 2})`);
}

main();
