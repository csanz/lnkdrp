/**
 * What each AI action costs, per quality level: one list for every surface that explains pricing.
 *
 * Released rows take their numbers from `creditsForRun`, the same function that charges a run, so
 * the UI cannot drift from the bill. Unreleased rows carry their intended prices as literals and
 * say they are not available yet.
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
  /** Credits per run, by quality level. */
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

export const COST_CATALOG: readonly CostCatalogEntry[] = [
  {
    action: "summary",
    label: "Summary and key points",
    detail: "Written when a document is uploaded or replaced, so a share page can describe itself.",
    costs: costsFor("summary"),
    notes: [
      "Runs at Basic automatically. Ask for a better one from the document page.",
      "Free when your own agent writes it over MCP or the API, and for files a recipient uploads.",
      "Out of credits? The upload and its links still work; the summary is skipped and you can run it later.",
    ],
    released: true,
  },
  {
    action: "history",
    label: "AI compare",
    detail: "What changed between two versions of a document, in plain language.",
    costs: costsFor("history"),
    notes: [
      "Runs automatically when you replace a PDF: Basic on Free, Standard on Pro.",
      "Skipped when credits run out; the version is still recorded and you can compare later.",
    ],
    released: true,
  },
  {
    action: "review",
    label: "AI review",
    detail: "Scores a document someone sent you against criteria you set, and explains the score.",
    costs: costsFor("review"),
    notes: ["Priced per document."],
    released: false,
  },
  {
    action: null,
    label: "Viewer follow-up briefs",
    detail: "A short brief on one viewer: the pages they lingered on, whether they came back, and a suggested next step.",
    costs: { basic: 1, standard: 1, advanced: 1 },
    notes: ["Priced per brief."],
    released: false,
  },
  {
    action: null,
    label: "Recipient Q&A",
    detail: "Readers ask a document questions on the share page, under a cap you set per reader and per link.",
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

/** The catalog entry for a ledger action, when it has one. */
export function costEntryForAction(action: ActionType): CostCatalogEntry | null {
  return COST_CATALOG.find((e) => e.action === action) ?? null;
}
