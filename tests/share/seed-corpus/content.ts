/**
 * The 50 documents of the seed corpus: page roles, per-page copy, agent summaries and share links.
 *
 * Pure and deterministic (no clock, no Math.random), so the PDFs, the manifest and the traffic plan
 * agree across runs. Page roles drive reader behaviour through `ROLE_PROFILE`.
 */

export type DocType =
  | "pitch_deck"
  | "investor_update"
  | "board_update"
  | "memo"
  | "proposal"
  | "research_report"
  | "pricing_proposal"
  | "data_room_overview"
  | "hiring_plan"
  | "security_whitepaper"
  | "product_one_pager";

export type PageSpec = {
  role: string;
  heading: string;
  bullets: string[];
  chart?: { kind: "bar" | "line"; values: number[] };
};

export type LinkSpec = { label: string; audience: string; allowDownload: boolean };

export type DocSpec = {
  slug: string;
  title: string;
  type: DocType;
  pages: PageSpec[];
  summary: string;
  keyPoints: string[];
  links: LinkSpec[];
};

export type RoleProfile = { interest: number; exitHazard: number; skipBias: number };

export const ROLE_PROFILE: Record<string, RoleProfile> = {
  pricing: { interest: 3.0, exitHazard: 0.25, skipBias: 0.1 },
  financials: { interest: 2.4, exitHazard: 0.2, skipBias: 0.1 },
  ask: { interest: 2.5, exitHazard: 0.15, skipBias: 0.1 },
  team: { interest: 2.2, exitHazard: 0.08, skipBias: 0.1 },
  traction: { interest: 2.0, exitHazard: 0.06, skipBias: 0.1 },
  metrics: { interest: 1.8, exitHazard: 0.06, skipBias: 0.1 },
  options: { interest: 2.2, exitHazard: 0.15, skipBias: 0.1 },
  roi: { interest: 2.0, exitHazard: 0.12, skipBias: 0.1 },
  compliance: { interest: 1.8, exitHazard: 0.08, skipBias: 0.1 },
  terms: { interest: 1.2, exitHazard: 0.2, skipBias: 0.3 },
  cover: { interest: 0.6, exitHazard: 0.15, skipBias: 0.0 },
  agenda: { interest: 0.4, exitHazard: 0.05, skipBias: 0.5 },
  index: { interest: 0.4, exitHazard: 0.05, skipBias: 0.5 },
  methodology: { interest: 0.8, exitHazard: 0.06, skipBias: 0.45 },
  appendix: { interest: 0.5, exitHazard: 0.35, skipBias: 0.6 },
  legal: { interest: 0.4, exitHazard: 0.4, skipBias: 0.7 },
  other: { interest: 1.0, exitHazard: 0.06, skipBias: 0.15 },
};

export function roleProfile(role: string): RoleProfile {
  return ROLE_PROFILE[role] ?? ROLE_PROFILE.other!;
}

export const SLIDE_TYPES: ReadonlySet<DocType> = new Set<DocType>(["pitch_deck", "investor_update", "board_update", "product_one_pager"]);

/** Page-count range per type (inclusive). */
export const TYPE_PAGES: Record<DocType, [number, number]> = {
  pitch_deck: [10, 16],
  investor_update: [6, 10],
  board_update: [8, 14],
  memo: [4, 6],
  proposal: [8, 12],
  research_report: [12, 20],
  pricing_proposal: [5, 8],
  data_room_overview: [6, 10],
  hiring_plan: [5, 8],
  security_whitepaper: [10, 16],
  product_one_pager: [4, 4],
};

export const TYPE_COUNTS: Array<[DocType, number]> = [
  ["pitch_deck", 10],
  ["investor_update", 6],
  ["board_update", 5],
  ["memo", 5],
  ["proposal", 6],
  ["research_report", 4],
  ["pricing_proposal", 3],
  ["data_room_overview", 3],
  ["hiring_plan", 3],
  ["security_whitepaper", 3],
  ["product_one_pager", 2],
];

const TYPE_LABEL: Record<DocType, string> = {
  pitch_deck: "Series A deck",
  investor_update: "Investor update",
  board_update: "Board update",
  memo: "Strategy memo",
  proposal: "Services proposal",
  research_report: "Market research report",
  pricing_proposal: "Pricing proposal",
  data_room_overview: "Data room overview",
  hiring_plan: "Hiring plan",
  security_whitepaper: "Security whitepaper",
  product_one_pager: "Product one-pager",
};

type Company = { name: string; sector: string; product: string; buyer: string; metric: string };

const COMPANIES: Company[] = [
  { name: "Northwind Robotics", sector: "warehouse automation", product: "picking arm", buyer: "3PL operators", metric: "picks per hour" },
  { name: "Lumen Health", sector: "remote patient monitoring", product: "care dashboard", buyer: "cardiology clinics", metric: "enrolled patients" },
  { name: "Brightwater Energy", sector: "grid-scale storage", product: "battery controller", buyer: "utilities", metric: "MWh under management" },
  { name: "Cobalt Ledger", sector: "B2B payments", product: "invoice network", buyer: "mid-market finance teams", metric: "payment volume" },
  { name: "Fernhill Foods", sector: "plant-based protein", product: "ready-meal line", buyer: "grocery chains", metric: "store doors" },
  { name: "Quarry Labs", sector: "developer tooling", product: "test runner", buyer: "platform teams", metric: "weekly active repos" },
  { name: "Tidepool Analytics", sector: "retail analytics", product: "shelf-level forecasting", buyer: "category managers", metric: "SKUs forecast" },
  { name: "Halcyon Travel", sector: "corporate travel", product: "policy-aware booking tool", buyer: "travel managers", metric: "trips booked" },
  { name: "Ironbark Security", sector: "identity security", product: "access graph", buyer: "security teams", metric: "identities protected" },
  { name: "Meridian Freight", sector: "freight brokerage", product: "carrier matching engine", buyer: "shippers", metric: "loads moved" },
  { name: "Saltmarsh Bio", sector: "enzyme manufacturing", product: "fermentation platform", buyer: "CPG formulators", metric: "litres of capacity" },
  { name: "Juniper Learning", sector: "workforce training", product: "skills platform", buyer: "HR leaders", metric: "active learners" },
  { name: "Kestrel Aerospace", sector: "satellite imaging", product: "revisit constellation", buyer: "insurers", metric: "square km imaged" },
  { name: "Mosaic Housing", sector: "modular construction", product: "factory-built units", buyer: "developers", metric: "units delivered" },
  { name: "Pinecrest Legal", sector: "legal operations", product: "contract review assistant", buyer: "in-house counsel", metric: "contracts reviewed" },
  { name: "Redwood Mobility", sector: "fleet electrification", product: "charging scheduler", buyer: "fleet managers", metric: "vehicles managed" },
  { name: "Silverline Insurance", sector: "embedded insurance", product: "policy API", buyer: "marketplaces", metric: "policies bound" },
  { name: "Atlas Agronomy", sector: "precision agriculture", product: "soil sensor network", buyer: "row-crop growers", metric: "acres monitored" },
  { name: "Beacon Payroll", sector: "global payroll", product: "contractor payments", buyer: "remote-first companies", metric: "workers paid" },
  { name: "Cedar Clinical", sector: "clinical trials", product: "site enrolment tool", buyer: "CROs", metric: "patients screened" },
  { name: "Driftwood Media", sector: "creator tools", product: "sponsorship marketplace", buyer: "consumer brands", metric: "campaigns run" },
  { name: "Ember Kitchens", sector: "restaurant software", product: "kitchen display system", buyer: "multi-unit operators", metric: "locations live" },
  { name: "Foxglove Pharma", sector: "specialty pharmacy", product: "prior-auth automation", buyer: "health systems", metric: "authorisations filed" },
  { name: "Granite Data", sector: "data infrastructure", product: "streaming warehouse", buyer: "data engineers", metric: "events per day" },
  { name: "Harborline Logistics", sector: "last-mile delivery", product: "route optimiser", buyer: "regional carriers", metric: "stops per route" },
  { name: "Ivory Dental", sector: "dental practice management", product: "scheduling suite", buyer: "dental groups", metric: "chairs scheduled" },
  { name: "Jadeite Games", sector: "mobile gaming", product: "live-ops toolkit", buyer: "game studios", metric: "daily players" },
  { name: "Keystone Utilities", sector: "water infrastructure", product: "leak detection", buyer: "municipal utilities", metric: "miles of pipe" },
  { name: "Larkspur Retail", sector: "resale commerce", product: "trade-in engine", buyer: "apparel brands", metric: "items resold" },
  { name: "Monarch Capital", sector: "SMB lending", product: "revenue-based financing", buyer: "e-commerce merchants", metric: "capital deployed" },
  { name: "Nimbus Weather", sector: "climate risk", product: "hyperlocal forecast API", buyer: "agriculture insurers", metric: "forecast calls" },
  { name: "Oakridge Senior Care", sector: "home care", product: "caregiver scheduling", buyer: "home-care agencies", metric: "visits scheduled" },
  { name: "Parallax Vision", sector: "industrial inspection", product: "defect detection camera", buyer: "manufacturers", metric: "parts inspected" },
  { name: "Quillmark Publishing", sector: "education publishing", product: "adaptive textbook", buyer: "school districts", metric: "students reached" },
  { name: "Riverstone Hotels", sector: "hospitality tech", product: "revenue management tool", buyer: "boutique hotel groups", metric: "rooms priced" },
  { name: "Sablewood Timber", sector: "mass timber", product: "CLT panels", buyer: "general contractors", metric: "cubic metres shipped" },
  { name: "Thistle Finance", sector: "treasury management", product: "cash forecasting", buyer: "CFOs", metric: "cash under forecast" },
  { name: "Umber Fashion", sector: "on-demand apparel", product: "micro-factory network", buyer: "DTC brands", metric: "garments produced" },
  { name: "Vantage Telecom", sector: "private 5G", product: "campus network kit", buyer: "port operators", metric: "sites connected" },
  { name: "Willow Pet Health", sector: "veterinary care", product: "tele-vet subscription", buyer: "pet owners", metric: "members" },
  { name: "Xenon Materials", sector: "battery materials", product: "silicon anode powder", buyer: "cell makers", metric: "tonnes shipped" },
  { name: "Yarrow Nutrition", sector: "clinical nutrition", product: "meal-plan engine", buyer: "dietitians", metric: "plans generated" },
  { name: "Zephyr Drones", sector: "drone inspection", product: "autonomous survey drone", buyer: "wind farm operators", metric: "turbines inspected" },
  { name: "Alder Compliance", sector: "regulatory compliance", product: "controls monitoring", buyer: "fintech compliance teams", metric: "controls tested" },
  { name: "Birchgate Security", sector: "cloud security", product: "posture scanner", buyer: "cloud platform teams", metric: "accounts scanned" },
  { name: "Copperleaf Cloud", sector: "managed Kubernetes", product: "cluster autopilot", buyer: "SRE teams", metric: "clusters managed" },
  { name: "Dunmore Recruiting", sector: "technical hiring", product: "work-sample assessments", buyer: "engineering managers", metric: "candidates assessed" },
  { name: "Evergreen Solar", sector: "commercial solar", product: "rooftop financing", buyer: "warehouse owners", metric: "MW installed" },
  { name: "Falcon Notes", sector: "sales productivity", product: "call summary assistant", buyer: "sales teams", metric: "calls summarised" },
  { name: "Glasswing Studio", sector: "design collaboration", product: "review canvas", buyer: "product designers", metric: "files reviewed" },
];

/** FNV-1a hash of a string, for deterministic per-doc choices. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic PRNG used across the seed tooling. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;
const int = (r: Rng, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const pickOne = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
function shuffled<T>(r: Rng, xs: readonly T[]): T[] {
  const out = xs.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Role order per type; `?` marks an optional role, `findings*` a repeated one, `extra*` security detail pages. */
const TYPE_ROLES: Record<DocType, string[]> = {
  pitch_deck: ["cover", "problem", "solution", "product", "market", "traction", "business-model", "pricing?", "competition", "team", "roadmap?", "financials", "ask", "appendix"],
  investor_update: ["cover", "highlights", "metrics", "product", "team", "financials", "ask", "appendix?"],
  board_update: ["cover", "agenda", "highlights", "metrics", "financials", "product", "team", "risks", "decisions", "appendix?"],
  memo: ["cover", "context", "proposal", "risks", "recommendation", "appendix?"],
  proposal: ["cover", "summary", "problem", "approach", "timeline", "team", "pricing", "terms", "appendix?"],
  research_report: ["cover", "summary", "methodology", "findings*", "market", "recommendations", "appendix", "legal?"],
  pricing_proposal: ["cover", "summary", "options", "pricing", "roi", "terms", "appendix?"],
  data_room_overview: ["cover", "index", "financials", "legal", "team", "customers", "appendix?"],
  hiring_plan: ["cover", "summary", "team", "roles", "financials", "timeline"],
  security_whitepaper: ["cover", "summary", "architecture", "extra*", "data-handling", "compliance", "incident-response", "appendix", "legal"],
  product_one_pager: ["cover", "product", "pricing", "contact"],
};

const FINDING_TOPICS = [
  "Buyers consolidate vendors",
  "Budgets shift to usage pricing",
  "Procurement cycles lengthen",
  "Mid-market adoption outpaces enterprise",
  "Integration depth drives renewal",
  "Security reviews gate expansion",
  "Self-serve trials convert better",
  "Regional demand diverges",
];

const SECURITY_EXTRAS = [
  "access-control",
  "encryption",
  "network-security",
  "vendor-management",
  "business-continuity",
  "secure-development",
];

const HEADINGS: Record<string, string[]> = {
  cover: ["{name}", "{name}: {typeLabel}", "{typeLabel} — {name}"],
  problem: ["Why {buyer} are stuck today", "The problem with {sector} now", "What breaks at scale"],
  solution: ["How the {product} fixes it", "Our approach to {sector}", "A {product} built for {buyer}"],
  product: ["Inside the {product}", "Product walkthrough", "What shipped this quarter"],
  market: ["Market size and timing", "Where {sector} is heading", "The opportunity in {sector}"],
  traction: ["Traction: {metric}", "Growth since launch", "Customer momentum"],
  "business-model": ["How we make money", "Unit economics", "Revenue model"],
  pricing: ["Pricing and packaging", "What it costs", "Plans and price points"],
  competition: ["Competitive landscape", "Why we win deals", "Alternatives buyers consider"],
  team: ["The team", "Who is building this", "Leadership and key hires"],
  roadmap: ["Roadmap for the next 18 months", "What comes next", "Product roadmap"],
  financials: ["Financials", "P&L and burn", "Revenue, margin and runway"],
  ask: ["The ask", "Raising this round", "Use of funds"],
  appendix: ["Appendix", "Supporting detail", "Appendix: definitions"],
  highlights: ["Highlights this period", "What went well", "Quarter at a glance"],
  metrics: ["Key metrics", "Operating dashboard", "KPIs against plan"],
  agenda: ["Agenda", "Meeting agenda", "Topics for today"],
  risks: ["Risks and mitigations", "What could go wrong", "Open risks"],
  decisions: ["Decisions needed from the board", "Board asks", "Votes and approvals"],
  context: ["Context", "Where we are today", "Background"],
  proposal: ["What we propose", "The proposal", "Recommended change"],
  recommendation: ["Recommendation", "Our recommendation", "Next steps we recommend"],
  summary: ["Executive summary", "Summary", "At a glance"],
  approach: ["Our approach", "How we will deliver", "Delivery approach"],
  timeline: ["Timeline", "Milestones and dates", "Plan by quarter"],
  terms: ["Terms", "Commercial terms", "Contract terms"],
  methodology: ["Methodology", "How we ran the study", "Data sources and method"],
  recommendations: ["Recommendations", "What to do with this", "Actions for buyers"],
  legal: ["Legal notices", "Disclaimers", "Legal and confidentiality"],
  options: ["Options", "Three ways to buy", "Packages compared"],
  roi: ["Return on investment", "Payback model", "Expected savings"],
  index: ["Data room index", "What is in the room", "Folder index"],
  customers: ["Customers", "Customer list and cohorts", "Reference customers"],
  roles: ["Roles to fill", "Open positions", "Hiring by function"],
  architecture: ["Architecture overview", "System architecture", "How the platform is built"],
  "data-handling": ["Data handling", "How customer data flows", "Data lifecycle"],
  compliance: ["Compliance", "Certifications and audits", "Regulatory posture"],
  "incident-response": ["Incident response", "When something goes wrong", "Response runbook"],
  contact: ["Contact", "Get in touch", "Talk to us"],
  "access-control": ["Access control"],
  encryption: ["Encryption at rest and in transit"],
  "network-security": ["Network security"],
  "vendor-management": ["Vendor management"],
  "business-continuity": ["Business continuity"],
  "secure-development": ["Secure development lifecycle"],
};

const BULLETS: Record<string, string[]> = {
  cover: ["{typeLabel} prepared for {buyer}", "Confidential — {month} 2026", "{name} builds the {product} for {sector}", "Prepared by the {name} leadership team"],
  problem: ["{buyer} lose {n}% of their week to manual work", "Legacy tools were built before {sector} went digital", "Errors cost the average team ${k}k a year", "No single system of record for {metric}", "Switching costs keep bad tools in place"],
  solution: ["One {product} replaces {n2} disconnected tools", "Setup in under {n2} days, no services team", "Works with the systems {buyer} already use", "Measured {n}% reduction in manual steps", "Priced per outcome, not per seat"],
  product: ["Live for {n3} customers in production", "New: automated exceptions queue", "Median response time {n2}00ms", "Mobile app for teams in the field", "Admin controls requested by enterprise buyers"],
  market: ["${n2}.{n1}B spent on {sector} in 2025", "Serviceable market of {n3}k {buyer}", "Category growing {n}% a year", "Regulation is pushing buyers to modernise", "Incumbents under-invest in product"],
  traction: ["{metric} up {n}% quarter over quarter", "{n3} paying customers, {n}% net retention", "Payback on sales spend in {n2} months", "Three of the top ten {buyer} signed", "Pipeline doubled since last update"],
  "business-model": ["Annual contracts billed upfront", "Gross margin {n}% and rising", "Land at ${k}k, expand to ${k2}k", "Usage fees on top of platform fee", "Services under 5% of revenue"],
  pricing: ["Starter: ${k}k per year", "Growth: ${k2}k per year with SSO and audit log", "Enterprise: custom, volume pricing on {metric}", "Discount of {n1}0% for multi-year terms", "Pilot credited against the first year"],
  competition: ["Incumbents sell suites, we sell outcomes", "Point tools lack the data we collect", "Win rate {n}% in competitive deals", "Faster deployment is the top reason we win", "No competitor covers {buyer} end to end"],
  team: ["CEO previously scaled {sector} startup to exit", "CTO led platform at a public company", "{n2} engineers, {n1} in go-to-market", "Advisors from three leading {buyer}", "Hiring a VP Sales next quarter"],
  roadmap: ["H1: self-serve onboarding", "H2: marketplace integrations", "Next year: international expansion", "AI assistance across the {product}", "Enterprise audit and compliance pack"],
  financials: ["ARR ${n2}.{n1}M, up {n}% year over year", "Monthly burn ${k}k, runway {n2} months", "Gross margin {n}%", "Break-even plan at ${n2}M ARR", "Revenue concentration: top 10 customers {n}%"],
  ask: ["Raising ${n2}M to reach ${k2}M ARR", "{n1}0% product and engineering", "{n1}5% sales and marketing", "18 months of runway after close", "Target close in {n2} weeks"],
  appendix: ["Definitions of every metric in this document", "Cohort tables by signup month", "Customer references available on request", "Assumptions behind the forecast", "Glossary of {sector} terms"],
  highlights: ["Closed {n2} new logos including two {buyer}", "{metric} crossed a new record", "Shipped the most requested feature", "Hired a Head of Customer Success", "Cash position stronger than plan"],
  metrics: ["{metric}: up {n}% on last period", "Net revenue retention {n3}%", "Logo churn {n1}.{n1}% monthly", "CAC payback {n2} months", "NPS {n} from {n3} responses"],
  agenda: ["Welcome and minutes", "Business review", "Financials and budget", "Risks and decisions", "Executive session"],
  risks: ["Concentration in {n1} large {buyer}", "Hiring pace behind plan", "Pricing pressure from incumbents", "Key vendor dependency", "Macro slowdown in {sector}"],
  decisions: ["Approve the updated operating budget", "Approve the option pool refresh", "Approve opening a second office", "Ratify the new auditor", "Set the date for the next meeting"],
  context: ["{buyer} demand changed faster than planned", "Our current plan assumes last year's mix", "Two teams own overlapping goals", "Customers ask for {product} bundles", "The window to act closes this quarter"],
  proposal: ["Merge the two {sector} teams", "Move {n}% of budget to the {product}", "Sunset the legacy tier by year end", "Add one pricing plan for {buyer}", "Review impact after {n2} months"],
  recommendation: ["Proceed with the proposal as written", "Start with a {n2}-week pilot", "Assign one accountable owner", "Report progress monthly", "Revisit if {metric} drops {n1}0%"],
  summary: ["{name} helps {buyer} with {sector}", "This document covers scope, plan and cost", "Expected impact: {n}% fewer manual steps", "Decision needed by the end of the month", "One-page view of everything that follows"],
  approach: ["Discovery workshops with {buyer}", "Configure the {product} in {n2} weeks", "Weekly checkpoint with your team", "Success metrics agreed upfront", "Handover and training in the final phase"],
  timeline: ["Weeks 1-2: discovery", "Weeks 3-6: build and configure", "Weeks 7-8: rollout", "Month 3: first business review", "Quarter 2: expansion"],
  terms: ["Annual term, renews automatically", "Net 30 payment terms", "Standard data processing agreement", "99.9% uptime commitment", "Termination for convenience after year one"],
  methodology: ["Survey of {n3} {buyer}", "{n2} structured interviews", "Usage data from {n3}k accounts", "Fieldwork in {month} 2026", "Margin of error ±{n1}%"],
  findings: ["{n}% of respondents agree", "Strongest among {buyer} with 500+ staff", "Up from {n2}% two years ago", "Budget owners and users disagree", "Implication: sell to the budget owner"],
  recommendations: ["Lead with outcomes, not features", "Package for {buyer} first", "Invest in integrations buyers ask for", "Price on {metric}", "Revisit segmentation yearly"],
  legal: ["This document is confidential", "Forward-looking statements are estimates", "Not an offer to sell securities", "Figures unaudited unless stated", "© 2026 {name}"],
  options: ["Option A: core {product}", "Option B: core plus analytics", "Option C: full platform with services", "All options include onboarding", "Switch options at renewal"],
  roi: ["Payback in {n2} months", "${k}k saved per year in labour", "{n}% fewer errors on {metric}", "Model assumes {n3} users", "Conservative case still positive in year one"],
  index: ["01 Corporate documents", "02 Financial statements", "03 Customer contracts", "04 Intellectual property", "05 People and equity"],
  customers: ["{n3} customers across {n1} regions", "Top customer under {n1}0% of revenue", "Cohort retention above {n}%", "Case studies from three {buyer}", "Logos available under NDA"],
  roles: ["{n2} engineers across platform and product", "{n1} account executives", "One product designer", "Customer success lead for {buyer}", "Finance manager"],
  architecture: ["Multi-tenant services on a major cloud", "Tenant isolation at the data layer", "Infrastructure as code, reviewed changes only", "Regional hosting in US and EU", "Zero-trust service-to-service auth"],
  "data-handling": ["Customer data classified at ingest", "PII minimised and access-logged", "Retention defaults to {n3} days", "Deletion within 30 days of request", "No customer data used to train models"],
  compliance: ["SOC 2 Type II, renewed yearly", "ISO 27001 certified", "GDPR and CCPA programmes", "Annual third-party penetration test", "HIPAA-ready configuration for {buyer}"],
  "incident-response": ["24/7 on-call rotation", "Customer notice within 72 hours", "Post-incident review for every sev-1", "Tabletop exercise each quarter", "Status page with history"],
  contact: ["Book a demo with our team", "sales@{domain}.test", "Pilot available for {buyer}", "Response within one business day", "{name}, San Francisco and London"],
  "access-control": ["SSO and SCIM for every plan", "Role-based access with least privilege", "Quarterly access reviews", "Hardware keys for production access", "Just-in-time admin elevation"],
  encryption: ["AES-256 at rest", "TLS 1.2+ in transit", "Keys managed in a cloud KMS", "Customer-managed keys on Enterprise", "Key rotation every 90 days"],
  "network-security": ["Private networking between services", "WAF and DDoS protection at the edge", "Egress allow-lists", "Continuous vulnerability scanning", "Segmented production environment"],
  "vendor-management": ["Sub-processor list published", "Security review before onboarding a vendor", "Annual vendor reassessment", "Contracts include breach notice terms", "Critical vendors have exit plans"],
  "business-continuity": ["Daily backups, tested monthly", "RPO {n1} hours, RTO {n2} hours", "Multi-zone deployment", "Disaster recovery drill twice a year", "Documented failover runbook"],
  "secure-development": ["Code review on every change", "Dependency scanning in CI", "Secrets never in source control", "Threat modelling for new features", "Security champions in each team"],
  other: ["Details for {buyer}", "Focus on {metric}", "Part of the {product} story", "Questions welcome"],
};

const CHART_ROLES = new Set(["metrics", "traction", "financials", "market", "findings", "roi", "customers", "highlights"]);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August"];

type LinkPool = Array<[string, string]>;

/**
 * The firms are invented, and have to stay that way.
 *
 * This pool named real ones — Sequoia, Accel, Index, Benchmark — and the corpus it seeds is the
 * workspace the product screenshots are taken from, so the homepage ended up showing an activity
 * feed in which several of the best-known funds in the world had apparently read someone's deck.
 * A label is private to the sender in the product, but a screenshot of one is a public claim about
 * a relationship that does not exist.
 *
 * The customer pool below had the right instinct from the start (Acme, Initech, Cyberdyne): names
 * everyone can see are made up. These are coined in the same spirit but in a register that survives
 * being photographed for a marketing page, which "Vandelay Ventures" would not.
 */
const INVESTOR_LINKS: LinkPool = [
  ["Northwind — Jordan Pike", "Northwind Ventures, growth team"],
  ["Harbourline — Dana Whitfield", "Harbourline Capital, partner intro"],
  ["Kestrel Row — Marco Lindqvist", "Kestrel Row, Series A diligence"],
  ["Fathom Point — Priya Haddad", "Fathom Point, London"],
  ["Alderway — Tomas Moreau", "Alderway Partners, first meeting follow-up"],
  ["Stonemoor — Amara Castellanos", "Stonemoor Capital, sector specialist"],
  ["Brightfall — Noor Okafor", "Brightfall Ventures, seed partner"],
  ["Tidewell — Felix Whitaker", "Tidewell Partners, partnership meeting"],
  ["Coppergate — Ines Park", "Coppergate Capital, pre-read"],
  ["Larkspur — Owen Achebe", "Larkspur Growth, infrastructure team"],
  ["Existing investors", "Current cap table, quarterly update"],
  ["Angel syndicate", "Operator angels, allocation call"],
  ["Hartwell family office", "Family office, co-invest review"],
  ["Evermoor — Lena Brandt", "Evermoor Partners, later stage"],
];

const BOARD_LINKS: LinkPool = [
  ["Board pre-read — Maria Chen", "Board chair, ahead of the meeting"],
  ["Audit committee", "Audit committee members"],
  ["Leadership team", "Executive staff"],
  ["CFO — Daniel Okafor", "Finance review before circulation"],
  ["Independent director — Ruth Alvarez", "Independent board member"],
  ["Board observer — Growth fund", "Observer seat, growth investor"],
  ["Exec offsite", "Offsite attendees"],
  ["Finance team", "FP&A and controller"],
  ["Outside counsel — Priya Raman", "Company counsel, legal review"],
  ["People team", "HR business partners"],
  ["Engineering leads", "Staff and principal engineers"],
];

const CUSTOMER_LINKS: LinkPool = [
  ["Acme procurement", "Acme Corp purchasing team"],
  ["Globex security review", "Globex information security"],
  ["Initech IT", "Initech IT operations"],
  ["Umbrella Health vendor risk", "Umbrella Health third-party risk"],
  ["Northwind buying committee", "Northwind Traders evaluation group"],
  ["Stark Industries legal", "Stark Industries commercial counsel"],
  ["Wayne Enterprises innovation", "Wayne Enterprises innovation lab"],
  ["Hooli partnerships", "Hooli business development"],
  ["Soylent finance", "Soylent Corp finance approvals"],
  ["Vandelay operations", "Vandelay Industries operations"],
  ["Cyberdyne CISO office", "Cyberdyne security leadership"],
  ["Tyrell renewal team", "Tyrell Corp account renewal"],
];

function linkPoolFor(type: DocType): LinkPool {
  if (type === "pitch_deck" || type === "investor_update" || type === "data_room_overview") return INVESTOR_LINKS;
  if (type === "board_update" || type === "memo" || type === "hiring_plan") return BOARD_LINKS;
  return CUSTOMER_LINKS;
}

function expandRoles(type: DocType, r: Rng): string[] {
  const [lo, hi] = TYPE_PAGES[type];
  for (let attempt = 0; attempt < 50; attempt++) {
    const roles: string[] = [];
    for (const raw of TYPE_ROLES[type]) {
      if (raw === "findings*") {
        const k = int(r, 4, 8);
        for (let i = 0; i < k; i++) roles.push("findings");
      } else if (raw === "extra*") {
        const k = int(r, 2, 6);
        roles.push(...shuffled(r, SECURITY_EXTRAS).slice(0, k));
      } else if (raw.endsWith("?")) {
        if (r() < 0.5) roles.push(raw.slice(0, -1));
      } else {
        roles.push(raw);
      }
    }
    if (roles.length >= lo && roles.length <= hi) return roles;
  }
  throw new Error(`no role layout for ${type} within ${lo}-${hi} pages`);
}

function fill(template: string, c: Company, typeLabel: string, r: Rng): string {
  return template
    .replace(/\{name\}/g, c.name)
    .replace(/\{sector\}/g, c.sector)
    .replace(/\{product\}/g, c.product)
    .replace(/\{buyer\}/g, c.buyer)
    .replace(/\{metric\}/g, c.metric)
    .replace(/\{typeLabel\}/g, typeLabel)
    .replace(/\{domain\}/g, slugify(c.name).replace(/-/g, ""))
    .replace(/\{month\}/g, () => pickOne(r, MONTHS))
    .replace(/\{n\}/g, () => String(int(r, 12, 88)))
    .replace(/\{n1\}/g, () => String(int(r, 1, 9)))
    .replace(/\{n2\}/g, () => String(int(r, 2, 30)))
    .replace(/\{n3\}/g, () => String(int(r, 40, 900)))
    .replace(/\{k\}/g, () => String(int(r, 12, 90)))
    .replace(/\{k2\}/g, () => String(int(r, 100, 480)));
}

function buildPages(type: DocType, c: Company, typeLabel: string, r: Rng): PageSpec[] {
  const roles = expandRoles(type, r);
  const used = new Set<string>();
  let finding = 0;
  const topics = shuffled(r, FINDING_TOPICS);
  return roles.map((role) => {
    let heading: string;
    if (role === "findings") {
      heading = `Finding ${finding + 1}: ${topics[finding % topics.length]}`;
      finding += 1;
    } else {
      const options = shuffled(r, HEADINGS[role] ?? [role.replace(/-/g, " ")]).map((h) => fill(h, c, typeLabel, r));
      heading = options.find((h) => !used.has(h)) ?? options[0]!;
    }
    if (used.has(heading)) heading = `${heading} (${used.size + 1})`;
    used.add(heading);
    const pool = BULLETS[role] ?? BULLETS.other!;
    const bullets = shuffled(r, pool)
      .slice(0, Math.min(pool.length, int(r, 3, 5)))
      .map((b) => fill(b, c, typeLabel, r))
      .map((b) => b.charAt(0).toUpperCase() + b.slice(1));
    const page: PageSpec = { role, heading, bullets };
    if (CHART_ROLES.has(role)) {
      const n = int(r, 5, 8);
      let v = int(r, 20, 60);
      const values: number[] = [];
      for (let i = 0; i < n; i++) {
        v = Math.max(5, Math.round(v * (0.9 + r() * 0.4)));
        values.push(v);
      }
      page.chart = { kind: r() < 0.5 ? "bar" : "line", values };
    }
    return page;
  });
}

function buildLinks(type: DocType, r: Rng): LinkSpec[] {
  const pool = shuffled(r, linkPoolFor(type));
  const count = int(r, 5, Math.min(10, pool.length));
  const links = pool.slice(0, count).map(([label, audience]) => ({ label, audience, allowDownload: r() < 0.35 }));
  if (!links.some((l) => l.allowDownload)) links[0]!.allowDownload = true;
  return links;
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

function buildSpec(index: number, type: DocType): DocSpec {
  const c = COMPANIES[index]!;
  const typeLabel = TYPE_LABEL[type];
  const r = mulberry32(hashString(`${c.name}|${type}`));
  const title = `${c.name} — ${typeLabel}`;
  const slug = slugify(`${c.name} ${type.replace(/_/g, " ")}`);
  const pages = buildPages(type, c, typeLabel, r);
  const interesting = pages.filter((p) => roleProfile(p.role).interest >= 1.8).map((p) => p.heading.toLowerCase());
  const summary = clip(
    `${c.name} ${typeLabel} for ${c.buyer}. It explains how the ${c.product} serves ${c.sector}, ` +
      `with ${pages.length} pages covering ${pages
        .slice(1, 5)
        .map((p) => p.heading.toLowerCase())
        .join(", ")}${interesting.length ? `, plus ${interesting.slice(0, 2).join(" and ")}` : ""}.`,
    600,
  );
  const keyPoints = pages
    .filter((p) => p.role !== "cover")
    .slice(0, int(r, 3, 5))
    .map((p) => clip(`${p.heading}: ${p.bullets[0]}`, 160));
  return { slug, title, type, pages, summary, keyPoints, links: buildLinks(type, r) };
}

function buildCorpus(): DocSpec[] {
  const specs: DocSpec[] = [];
  let i = 0;
  for (const [type, count] of TYPE_COUNTS) {
    for (let k = 0; k < count; k++) specs.push(buildSpec(i++, type));
  }
  return specs;
}

export const DOC_SPECS: DocSpec[] = buildCorpus();
