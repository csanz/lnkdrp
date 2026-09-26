/**
 * The homepage product shot for the Slack integration: the settings page and the channel it posts to.
 *
 * Composed, never hand-cropped (the rule every home shot follows). Two halves, built differently on
 * purpose:
 *
 *  - **The settings page** is one real 1x screenshot, `scripts/home-shot-slack/slack-settings.png`,
 *    taken from a signed-in browser. It is a page, and a picture of a page is the honest way to show
 *    one. It lives outside `public/` because everything under `public/` is served and only the
 *    finished composite belongs on the web.
 *  - **The channel** is *drawn here*, from the same `SLACK_MARKS` the renderer posts with, the way
 *    `home-shot-brief.ts` composes its three emails from the real `composeVisitBriefEmail`. It used
 *    to be a screenshot of a real Slack channel and that was the wrong call twice over. The content
 *    was whatever happened to be in the workspace that afternoon — the bold last line read "spent 30
 *    sec on the lorem ipsum text … which is filled with placeholder content", a round-terms document
 *    became "a new list of books from Project Gutenberg", and the reader was introduced as
 *    `ana@greylock.example`, an invented person wearing a real firm's name. And a screenshot cannot
 *    follow the product: the colours and emoji below are imported, so a change to either shows up
 *    here the next time this runs instead of silently drifting.
 *
 * Everyone in it is invented — Ana Lima, Kestrel Row, Fundraising 2026, Diligence uploads — because
 * these end up legible at full size on a public page. Same rule, same reason, as the brief shot.
 *
 * The settings page is the ground and the channel sits in front of it, bottom-right, the way a Slack
 * window sits over the app on a desk: the first card's five switches (what can post) stay fully
 * visible with the second card's name and routing chips, and the messages (what actually posted)
 * cover only the second card's repeat of the switches. Two other layouts were judged against this
 * one and lost: both channel shots stacked (the one behind survived as a strip of clipped avatars),
 * and the mirror (the window then covers the labels, which are the half of the settings page that
 * says anything).
 *
 *   npx tsx scripts/home-shot-slack.ts
 *   → public/images/home/slack.png (2000×1200)
 *
 * `--out <file>` writes elsewhere, for comparing a retake against the shipped one. `CHROME_PATH`
 * overrides the browser; the default covers macOS, Windows and Linux.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { SLACK_MARKS } from "@/lib/slack/messages";

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter((p): p is string => !!p);

const SRC = path.resolve(process.cwd(), "scripts/home-shot-slack");
const WORK = path.resolve(process.cwd(), "tmp/home-shot-slack");

/** Frame, at 1x — the settings capture is a 1x screenshot and is placed at its own pixel size. */
const WIDTH = 2000;
const HEIGHT = 1200;
const PAD = 40;

/** Intrinsic size of the one screenshot; the layout depends on it, so it is stated not measured. */
const SETTINGS = { file: "slack-settings.png", w: 1677, h: 1028 };

/**
 * Where the channel window goes, in frame pixels. Its left edge lands in the gap between the second
 * card's description text (which ends near x=936) and its switch column (which starts near x=985),
 * so those switches are covered whole rather than sliced down the middle. Its top sits on the first
 * card's "Routing · catch-all" row, which starts 437px into the settings capture, so the offset
 * reads as placed rather than missed.
 */
const FEED = { x: 947, y: PAD + 437, w: 1013 };

/** Slack's own surface, so the window reads as Slack and not as our UI wearing a dark theme. */
const SLACK = { bg: "#1a1d21", edge: "#2c3034", text: "#d1d2d3", bright: "#ffffff", dim: "#9a9b9e", link: "#1d9bd1" };

type Line = { mark: string; html: string; context: string; color: string };

const emoji = (shortcode: string): string =>
  ({
    [SLACK_MARKS.opened]: "👀",
    [SLACK_MARKS.introduced]: "👋",
    [SLACK_MARKS.brief]: "📖",
    [SLACK_MARKS.received]: "📨",
    [SLACK_MARKS.added]: "📄",
    [SLACK_MARKS.replaced]: "🔄",
    [SLACK_MARKS.newLink]: "🔗",
    [SLACK_MARKS.room]: "📁",
    [SLACK_MARKS.inbox]: "📥",
  })[shortcode] ?? shortcode;

/** A room as the renderer writes it: its mark, then its name. */
const room = (name: string) => `${emoji(SLACK_MARKS.room)} <b><a>${name}</a></b>`;
const doc = (name: string) => `<b><a>${name}</a></b>`;

/**
 * One day in a data room, in the order it would actually happen: the room fills, links go out, a
 * version changes, then a reader arrives, opens, reads to the end — and a file comes back.
 */
const LINES: Line[] = [
  {
    color: SLACK_MARKS.workspace,
    mark: SLACK_MARKS.added,
    html: `${doc("Fundraising memo")} was added to ${room("Fundraising 2026")} · 3 pages`,
    context: `<a>open it</a> · <a>metrics</a>`,
  },
  {
    color: SLACK_MARKS.workspace,
    mark: SLACK_MARKS.added,
    html: `${doc("Round terms")} was added to ${room("Fundraising 2026")} · 1 page`,
    context: `<a>open it</a> · <a>metrics</a>`,
  },
  {
    color: SLACK_MARKS.workspace,
    mark: SLACK_MARKS.newLink,
    html: `New link <b>Investors</b> for ${room("Fundraising 2026")}`,
    context: `for Round participants · <a>open the data room</a>`,
  },
  {
    color: SLACK_MARKS.workspace,
    mark: SLACK_MARKS.replaced,
    html: `${doc("Round terms")} was replaced, now v2<br>The closing date moved to 14 March and the pro-rata clause was cut.`,
    context: `Every link keeps working and shows the new version · <a>what changed</a>`,
  },
  {
    color: SLACK_MARKS.recipient,
    mark: SLACK_MARKS.introduced,
    html: `<b>Ana Lima</b> introduced themselves on ${room("Fundraising 2026")}<br>ana@kestrelrow.example`,
    context: `via Investors · <a>this reader</a>`,
  },
  {
    color: SLACK_MARKS.recipient,
    mark: SLACK_MARKS.opened,
    html: `<b>Ana Lima</b> opened <a>Fundraising memo</a>`,
    context: `via Investors · <a>this reader</a>`,
  },
  {
    color: SLACK_MARKS.recipient,
    mark: SLACK_MARKS.brief,
    html: `<b>Ana Lima finished reading <a>Fundraising memo</a></b><br><b>spent 2 min on the use of funds, and came back to it twice</b><br>Ana spent about two minutes on page 3, which sets out the 18-month runway and the hiring plan, and returned to it after reading the team page. She skipped the appendix.`,
    context: `3 pages · 4m 12s · <a>the visit</a>`,
  },
  {
    color: SLACK_MARKS.recipient,
    mark: SLACK_MARKS.received,
    html: `${doc("signed-nda.pdf")} was received in ${emoji(SLACK_MARKS.inbox)} <b><a>Diligence uploads</a></b>`,
    context: `<a>open it</a>`,
  },
];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function chrome(): string {
  const found = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!found) throw new Error("No Chrome found; set CHROME_PATH");
  return found;
}

function channelHtml(): string {
  const rows = LINES.map(
    (l) => `<div class="m" style="border-left-color:${l.color}">
        <div class="t"><span class="e">${emoji(l.mark)}</span> ${l.html}</div>
        <div class="c">${l.context}</div>
      </div>`,
  ).join("");
  return `<div class="slack">
      <div class="who"><div class="av">✈</div><b>LinkDrop</b><span class="app">APP</span><span class="ts">2:26 PM</span></div>
      ${rows}
    </div>`;
}

function main(): void {
  const out = path.resolve(process.cwd(), arg("--out") ?? "public/images/home/slack.png");
  mkdirSync(WORK, { recursive: true });
  mkdirSync(path.dirname(out), { recursive: true });

  const settings = path.join(SRC, SETTINGS.file);
  if (!existsSync(settings)) throw new Error(`missing ${settings}`);
  if (FEED.x + FEED.w + PAD > WIDTH) throw new Error("the channel window does not fit the frame");

  const page = `<!doctype html><html><head><meta charset="utf-8">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Lato:wght@400;700;900&display=swap">
  <style>
    html,body{margin:0;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden;background:#09090b;}
    .frame{position:relative;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden;
      background:
        radial-gradient(1000px 560px at 50% -10%, rgba(255,255,255,0.10), transparent 70%),
        linear-gradient(180deg,#0f0f11 0%,#09090b 100%);}
    /* Two dark surfaces on a dark ground: each needs an edge, and the window in front a shadow deep
       enough to read as sitting on the page behind it rather than painted onto it. */
    .card{position:absolute;border-radius:14px;overflow:hidden;
      box-shadow:0 0 0 1px rgba(255,255,255,0.14), 0 48px 100px -20px rgba(0,0,0,0.9), 0 16px 40px rgba(0,0,0,0.6);}
    .card::after{content:"";position:absolute;inset:0;pointer-events:none;
      background:linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0) 40%);}
    .card img{display:block;}
    .slack{background:${SLACK.bg};color:${SLACK.text};padding:18px 18px 20px;
      font-family:Lato,system-ui,sans-serif;font-size:15px;line-height:1.46;}
    .who{display:flex;align-items:center;gap:9px;margin-bottom:12px;}
    .av{width:32px;height:32px;border-radius:8px;background:#fff;color:${SLACK.bg};
      display:grid;place-items:center;font-size:17px;}
    .who b{color:${SLACK.bright};font-weight:900;}
    .app{background:#3f4247;color:#abadb0;font-size:10px;font-weight:700;padding:1px 4px;border-radius:2px;letter-spacing:.04em;}
    .ts{color:${SLACK.dim};font-size:12px;}
    .m{padding:3px 0 4px 13px;border-left:3px solid transparent;}
    .m + .m{margin-top:3px;}
    .t b{color:${SLACK.bright};font-weight:700;}
    .c{color:${SLACK.dim};font-size:13px;margin-top:1px;}
    a{color:${SLACK.link};text-decoration:none;}
    .e{font-family:"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif;}
  </style></head><body><div class="frame">
    <div class="card" style="left:${PAD}px;top:${PAD}px;width:${SETTINGS.w}px;height:${SETTINGS.h}px">
      <img src="${pathToFileURL(settings).href}" width="${SETTINGS.w}" height="${SETTINGS.h}" alt="">
    </div>
    <div class="card" style="left:${FEED.x}px;top:${FEED.y}px;width:${FEED.w}px">${channelHtml()}</div>
  </div></body></html>`;
  const pageFile = path.join(WORK, "frame.html");
  writeFileSync(pageFile, page);

  execFileSync(
    chrome(),
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      `--window-size=${WIDTH},${HEIGHT}`,
      // Long enough for the webfont to arrive; without it the channel sets in a fallback face.
      "--virtual-time-budget=6000",
      `--screenshot=${out}`,
      pathToFileURL(pageFile).href,
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  // eslint-disable-next-line no-console
  console.log(`wrote ${out} (${WIDTH}×${HEIGHT})`);
}

main();
