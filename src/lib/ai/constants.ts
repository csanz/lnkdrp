/**
 * Shared AI constants for document analysis.
 *
 * Used by both server-side AI analysis and client-side UI components.
 */

export const CATEGORY_VALUES = [
  "fundraising_pitch",
  "sales_pitch",
  "product_overview",
  "technical_whitepaper",
  "business_plan",
  "investor_update",
  "financial_report",
  "market_research",
  "internal_strategy",
  "partnership_proposal",
  "marketing_material",
  "training_or_manual",
  "legal_document",
  "resume_or_profile",
  "academic_paper",
  "other",
] as const;

export type CategoryValue = (typeof CATEGORY_VALUES)[number];

export const CATEGORY_LABELS: Record<CategoryValue, string> = {
  fundraising_pitch: "Fundraising Pitch",
  sales_pitch: "Sales Pitch",
  product_overview: "Product Overview",
  technical_whitepaper: "Technical Whitepaper",
  business_plan: "Business Plan",
  investor_update: "Investor Update",
  financial_report: "Financial Report",
  market_research: "Market Research",
  internal_strategy: "Internal Strategy",
  partnership_proposal: "Partnership Proposal",
  marketing_material: "Marketing Material",
  training_or_manual: "Training or Manual",
  legal_document: "Legal Document",
  resume_or_profile: "Resume or Profile",
  academic_paper: "Academic Paper",
  other: "Other",
};

export const INTENDED_AUDIENCE_VALUES = [
  "investors",
  "customers",
  "partners",
  "internal",
  "general",
  "unknown",
] as const;

export type IntendedAudienceValue = (typeof INTENDED_AUDIENCE_VALUES)[number];

export const INTENDED_AUDIENCE_LABELS: Record<IntendedAudienceValue, string> = {
  investors: "Investors",
  customers: "Customers",
  partners: "Partners",
  internal: "Internal",
  general: "General",
  unknown: "Unknown",
};

export const STAGE_VALUES = [
  "idea",
  "pre-seed",
  "seed",
  "series_a",
  "growth",
  "mature",
  "unknown",
] as const;

export type StageValue = (typeof STAGE_VALUES)[number];

export const STAGE_LABELS: Record<StageValue, string> = {
  idea: "Idea",
  "pre-seed": "Pre-Seed",
  seed: "Seed",
  series_a: "Series A",
  growth: "Growth",
  mature: "Mature",
  unknown: "Unknown",
};

export const TONE_VALUES = ["formal", "persuasive", "technical", "marketing", "internal", "mixed"] as const;

export type ToneValue = (typeof TONE_VALUES)[number];

export const CONFIDENCE_VALUES = ["low", "medium", "high"] as const;

export type ConfidenceValue = (typeof CONFIDENCE_VALUES)[number];
