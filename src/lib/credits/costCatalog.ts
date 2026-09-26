/**
 * What each AI action costs, per quality level: one list for every surface that explains pricing.
 *
 * Released rows take their numbers from `creditsForRun`, the same function that charges a run, so
 * the UI cannot drift from the bill. Unreleased rows carry their intended prices as literals and
 * say they are not available yet.
 *
 * A row also declares the levels a person can actually pick (`levels`). An action the product only
 * ever runs at one level advertises one price and no level, whatever the schedule would charge at
 * the other two: an unpickable price is an advertisement for something that cannot be bought.
 *
 * `/pricing` still renders its own table in the marketing layout; this catalog is what the app uses
 * (the Usage tab's cost modal). Keep the two in agreement if the schedule changes.
 */
import { creditsForRun } from "@/lib/credits/schedule";
import type { ActionType, QualityTier } from "@/lib/credits/types";

export const QUALITY_TIERS: readonly QualityTier[] = ["basic", "standard", "advanced"] as const;

export const QUALITY_LABELS: Record<QualityTier, string> = {
  basic: "Basic",
  standard: "Standard",
  advanced: "Advanced",
};

/** What each level means in practice, for the modal's header row. */
export const QUALITY_BLURBS: Record<QualityTier, string> = {
  basic: "Quick pass. Fine for short documents and everyday changes.",
  standard: "More careful reading. The default for AI compare on Pro.",
  advanced: "Deepest reading, for long or high-stakes documents.",
};

export type CostCatalogEntry = {
  /** The ledger's action type, so a usage row can open its own entry. Null for unreleased features. */
  action: ActionType | null;
  label: string;
  /** One line on what the action is and when it runs. */
  detail: string;
  /**
   * The quality levels a person can actually pick for this action.
   *
   * Empty means the action has one price and nothing to choose, and every surface renders the row
   * as a single price instead of three. This is what stops the table advertising a level the
   * product has no way to order: see the note on the summary row below.
   */
  levels: readonly QualityTier[];
  /**
   * Credits per run, by quality level. All three numbers are the same when `levels` is empty, so a
   * renderer that ignores `levels` still prints a true price.
   */
  costs: Record<QualityTier, number>;
  /** Anything worth knowing beyond the price (what makes it free, which level runs automatically). */
  notes?: string[];
  released: boolean;
};

/** Credits for a released action at each level, straight from the charging schedule. */
function costsFor(action: ActionType): Record<QualityTier, number> {
  return {
    basic: creditsForRun({ actionType: action, qualityTier: "basic" }),
    standard: creditsForRun({ actionType: action, qualityTier: "standard" }),
    advanced: creditsForRun({ actionType: action, qualityTier: "advanced" }),
  };
}

/**
 * Credits for a released action that runs at one level and offers no choice, straight from the
 * charging schedule: the tier every production path pins it to, repeated across the record so the
 * row reads the same whichever level a caller looks up.
 */
function flatCostFor(action: ActionType, tier: QualityTier): Record<QualityTier, number> {
  const credits = creditsForRun({ actionType: action, qualityTier: tier });
  return { basic: credits, standard: credits, advanced: credits };
}

export const COST_CATALOG: readonly CostCatalogEntry[] = [
  /**
   * The summary is sold at one price because one price is all the product can charge.
   *
   * What went wrong: this row quoted `costsFor("summary")`, so `/costs` and `/pricing` advertised
   * 1, 2 and 5 credits by level, and the first note told people to "ask for a better one from the
   * document page". Nothing in the product can order a summary above Basic. The processing job
   * pins it (`const summaryTier = "basic"` in the upload process route), the manual "write the
   * summary again" route prices and queues at Basic and accepts no level from the caller
   * (`POST /api/uploads/:uploadId/summary`), and no screen anywhere offers a level for a summary -
   * the only level chooser in the app is AI compare's, on the document history page. So two of the
   * three advertised prices were unreachable and the note sent readers hunting for a control that
   * does not exist. Advertised as one price with no level, the way the visit brief already is.
   */
  {
    action: "summary",
    label: "Summary and key points",
    detail: "Written when a document is uploaded or replaced, so a share page can describe itself.",
    levels: [],
    costs: flatCostFor("summary", "basic"),
    notes: [
      "One price; there is no quality level to choose.",
      "Written automatically on upload. If it was skipped or it failed, write it again from the document page for the same one credit.",
      "Free when your own agent writes it over MCP or the API, and for files a recipient uploads.",
      "Out of credits? The upload and its links still work; the summary is skipped and you can run it later.",
    ],
    released: true,
  },
  {
    action: "history",
    label: "AI compare",
    detail: "What changed between two versions of a document, in plain language.",
    levels: QUALITY_TIERS,
    costs: costsFor("history"),
    notes: [
      "Runs automatically when you replace a PDF: Basic on Free, Standard on Pro.",
      "Pick the level yourself when you run a compare again from the document history.",
      "Skipped when credits run out; the version is still recorded and you can compare later.",
    ],
    released: true,
  },
  /**
   * Still unreleased, and the literals are the point.
   *
   * The charging schedule prices review at 2/5/12 and `POST /api/uploads/:uploadId/process
   * ?forceReview=1` will run and charge it, but no customer can reach it: the review page and the
   * request-repo panels that call that route are all behind `NEXT_PUBLIC_FEATURE_REQUESTS`, which
   * is unset at launch, and DEPLOY.md and docs/FEATURES.md both record AI review as not released.
   * "Not available yet" is the true statement, so this row now follows the rule at the top of this
   * file that unreleased rows carry their intended prices as literals rather than quoting the live
   * bill for something nobody can buy.
   */
  {
    action: "review",
    label: "AI review",
    detail: "Scores a document someone sent you against criteria you set, and explains the score.",
    levels: QUALITY_TIERS,
    costs: { basic: 2, standard: 5, advanced: 12 },
    notes: ["Priced per document.", "Not available yet: it arrives with document requests."],
    released: false,
  },
  {
    action: "brief",
    label: "Visit brief",
    detail: "A short account of one recipient's visit, written a few minutes after they stop reading: what held them, what they skipped, and how it compares with their last visit.",
    levels: [],
    costs: flatCostFor("brief", "basic"),
    notes: [
      "Runs automatically on Pro, a few minutes after each visit ends. One price; there is no quality level to choose.",
      "Skipped for a glance (under 20 seconds on one page) and for your own opens. Out of credits? You still get the facts of the visit, without the write-up.",
      "Turn it off under AI defaults, or set how you hear about it under Notifications.",
    ],
    released: true,
  },
  {
    action: null,
    label: "Recipient Q&A",
    detail: "Readers ask a document questions on the share page, under a cap you set per reader and per link.",
    levels: QUALITY_TIERS,
    costs: { basic: 1, standard: 2, advanced: 5 },
    notes: ["Priced per answered question."],
    released: false,
  },
];

/** Everything that never costs credits, so the modal can answer "what is free?" in the same place. */
export const FREE_ACTIONS: readonly string[] = [
  "Uploading, replacing and sharing documents",
  "Share links, passwords, expiry and download control",
  "Views, downloads, time on page and every other analytic",
  "Summaries your agent writes over MCP or the API",
  "Summaries for files recipients upload through a request or replace link",
];

/** Anchor for a row on `/costs`, so a usage charge can link to its own line. */
export function costAnchorId(entry: Pick<CostCatalogEntry, "action" | "label">): string {
  return entry.action ?? entry.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Whether the row offers a choice of quality level. False means one price and nothing to pick, and
 * a renderer should print a single price for the whole row rather than one per level.
 */
export function hasQualityLevels(entry: Pick<CostCatalogEntry, "levels">): boolean {
  return entry.levels.length > 0;
}

/** The single price of a row that offers no level (`levels` empty); every level holds it. */
export function flatPriceOf(entry: Pick<CostCatalogEntry, "costs">): number {
  return entry.costs.basic;
}

/** The catalog entry for a ledger action, when it has one. */
export function costEntryForAction(action: ActionType): CostCatalogEntry | null {
  return COST_CATALOG.find((e) => e.action === action) ?? null;
}
