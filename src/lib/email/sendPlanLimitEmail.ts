/**
 * Email helper: plan-limit grace period emails for Free workspaces.
 *
 * Three kinds:
 * - `started`  — the workspace just went over a Free limit; explains the 14-day grace window.
 * - `reminder` — a nudge partway through the window ("7 days left…", "2 days left…").
 * - `blocked`  — the window has ended; sharing new documents / new projects is paused until they are back under
 *   the limits or upgrade. Existing links keep working.
 *
 * Delivery goes through `sendTextEmail` (Resend), which honours `EMAIL_TRANSPORT=console`
 * for local runs so nothing is actually sent.
 */
import { sendTextEmail } from "@/lib/email/sendTextEmail";
import {
  FREE_DOCUMENTS,
  FREE_PROJECTS,
  PRO_INCLUDED_COLLABORATORS,
} from "@/lib/billing/planLimits";

export type PlanLimitEmailKind = "started" | "reminder" | "blocked";

export type SendPlanLimitEmailParams = {
  to: string;
  kind: PlanLimitEmailKind;
  workspaceName: string;
  usage: { documents: number; projects: number; members: number };
  /** When the grace window ends (or ended, for `blocked`). */
  endsAt: Date;
  /** Absolute URL to the pricing page. */
  pricingUrl: string;
  /** Reference "now" for the days-left computation (defaults to the wall clock). */
  now?: Date;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Format a date as e.g. "September 26, 2026" (UTC) for email copy. */
function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

/** Whole days remaining until `endsAt` (never negative). */
function daysLeft(endsAt: Date, now: Date): number {
  return Math.max(0, Math.ceil((endsAt.getTime() - now.getTime()) / DAY_MS));
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Human summary of what is over the Free limits, one line per limit. */
function overLimitLines(usage: SendPlanLimitEmailParams["usage"]): string[] {
  const lines: string[] = [];
  if (usage.documents > FREE_DOCUMENTS) {
    lines.push(
      `- Shared documents: ${usage.documents} (Free includes ${plural(FREE_DOCUMENTS, "shared document", "shared documents")}; links per document are not limited)`,
    );
  }
  if (usage.projects > FREE_PROJECTS) {
    lines.push(`- Projects: ${usage.projects} (Free includes ${plural(FREE_PROJECTS, "project", "projects")})`);
  }
  const collaborators = Math.max(0, usage.members - 1);
  if (collaborators > 0) {
    lines.push(
      `- Collaborators: ${collaborators} (Free is for one person; Pro includes ${plural(PRO_INCLUDED_COLLABORATORS, "collaborator", "collaborators")})`,
    );
  }
  return lines;
}

/** Build the subject + plain-text body for a plan-limit email. */
export function buildPlanLimitEmail(params: SendPlanLimitEmailParams): { subject: string; text: string } {
  const { kind, workspaceName, usage, endsAt, pricingUrl } = params;
  const now = params.now ?? new Date();
  const name = workspaceName.trim() || "your workspace";
  const endsOn = formatDate(endsAt);
  const over = overLimitLines(usage);
  const overBlock = over.length ? ["Right now it has:", ...over] : [];

  const howToFix = [
    "To stay on Free, bring the workspace back under the limits (archive a document, archive a project, or remove a collaborator).",
    `Or upgrade to Pro for unlimited documents and projects: ${pricingUrl}`,
  ];

  if (kind === "started") {
    return {
      subject: "Your LinkDrop workspace is over the Free limits",
      text: [
        `Hi,`,
        "",
        `"${name}" is over the limits of the Free plan.`,
        "",
        ...overBlock,
        ...(overBlock.length ? [""] : []),
        `Nothing changes today. You have until ${endsOn} to sort it out. After that, sharing new documents and creating projects on this workspace will be paused until it is back under the limits or on Pro.`,
        "",
        "Existing links keep working the whole time. Nothing is deleted.",
        "",
        ...howToFix,
        "",
        "- LinkDrop",
      ].join("\n"),
    };
  }

  if (kind === "reminder") {
    const left = daysLeft(endsAt, now);
    const leftLabel = plural(left, "day", "days");
    return {
      subject: `${leftLabel} left: "${name}" is still over the Free limits`,
      text: [
        `Hi,`,
        "",
        `Quick reminder: "${name}" is still over the Free plan limits, and the grace period ends on ${endsOn} (${leftLabel} left).`,
        "",
        ...overBlock,
        ...(overBlock.length ? [""] : []),
        "When it ends, new shared documents and projects on this workspace will be paused. Existing links keep working, and you can still add links to the documents you already share.",
        "",
        ...howToFix,
        "",
        "- LinkDrop",
      ].join("\n"),
    };
  }

  return {
    subject: "New documents are paused on this workspace",
    text: [
      `Hi,`,
      "",
      `The grace period for "${name}" ended on ${endsOn}, and it is still over the Free plan limits. Sharing new documents and creating projects are paused on this workspace for now.`,
      "",
      ...overBlock,
      ...(overBlock.length ? [""] : []),
      "Your existing links keep working and nothing has been deleted.",
      "",
      "To pick up where you left off, bring the workspace back under the limits (archive a document, archive a project, or remove a collaborator) and creating resumes immediately.",
      `Or upgrade to Pro for unlimited documents and projects: ${pricingUrl}`,
      "",
      "- LinkDrop",
    ].join("\n"),
  };
}

/**
 * Send one plan-limit grace email to a workspace owner.
 *
 * Throws when the transport fails (callers isolate per workspace). Honours
 * `EMAIL_TRANSPORT=console` via `sendTextEmail`.
 */
export async function sendPlanLimitEmail(params: SendPlanLimitEmailParams): Promise<void> {
  const { subject, text } = buildPlanLimitEmail(params);
  await sendTextEmail({ to: params.to, subject, text });
}
