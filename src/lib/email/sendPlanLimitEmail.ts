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
import { blocks, transactional, type EmailContent } from "@/lib/email/templates/compose";
import type { Block } from "@/lib/email/layout";
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

/**
 * What is over, one item per limit.
 *
 * These used to carry their own "- " prefix, because the only consumer joined them into a text
 * body. The renderer owns the bullet now, so the HTML gets a real `<ul>` instead of a paragraph
 * that begins with a hyphen.
 */
function overLimitItems(usage: SendPlanLimitEmailParams["usage"]): string[] {
  const lines: string[] = [];
  if (usage.documents > FREE_DOCUMENTS) {
    lines.push(
      `Shared documents: ${usage.documents} (Free includes ${plural(FREE_DOCUMENTS, "shared document", "shared documents")}; links per document are not limited)`,
    );
  }
  if (usage.projects > FREE_PROJECTS) {
    lines.push(`Projects: ${usage.projects} (Free includes ${plural(FREE_PROJECTS, "project", "projects")})`);
  }
  const collaborators = Math.max(0, usage.members - 1);
  if (collaborators > 0) {
    lines.push(
      `Collaborators: ${collaborators} (Free is for one person; Pro includes ${plural(PRO_INCLUDED_COLLABORATORS, "collaborator", "collaborators")})`,
    );
  }
  return lines;
}

/** Build the subject and both bodies for a plan-limit email. */
export function buildPlanLimitEmail(params: SendPlanLimitEmailParams): EmailContent {
  const { kind, workspaceName, usage, endsAt, pricingUrl } = params;
  const now = params.now ?? new Date();
  const name = workspaceName.trim() || "your workspace";
  const endsOn = formatDate(endsAt);
  const over = overLimitItems(usage);

  /** The "what is over" section, or nothing at all when we cannot name a specific limit. */
  const overBlocks: Array<Block | null> = over.length
    ? [{ kind: "p", text: "Right now it has:" }, { kind: "bullets", items: over }]
    : [];

  /** Both ways out, in the order we would rather they took them. */
  const howToFix: Array<Block | null> = [
    {
      kind: "p",
      text: "To stay on Free, bring the workspace back under the limits (archive a document, archive a project, or remove a collaborator).",
    },
    { kind: "action", label: "Upgrade to Pro", url: pricingUrl },
  ];

  if (kind === "started") {
    return transactional({
      subject: "Your LinkDrop workspace is over the Free limits",
      preheader: `Nothing changes today. You have until ${endsOn}.`,
      blocks: blocks(
        { kind: "heading", text: `"${name}" is over the Free plan limits` },
        { kind: "p", text: "Nothing is paused yet." },
        ...overBlocks,
        {
          kind: "p",
          text: `You have until ${endsOn} to sort it out. After that, sharing new documents and creating projects on this workspace will be paused until it is back under the limits or on Pro.`,
        },
        { kind: "p", text: "Existing links keep working the whole time. Nothing is deleted." },
        ...howToFix,
      ),
    });
  }

  if (kind === "reminder") {
    const left = daysLeft(endsAt, now);
    const leftLabel = plural(left, "day", "days");
    return transactional({
      subject: `${leftLabel} left: "${name}" is still over the Free limits`,
      preheader: `The grace period ends on ${endsOn}.`,
      blocks: blocks(
        { kind: "heading", text: `${leftLabel} left on "${name}"` },
        {
          kind: "p",
          text: `It is still over the Free plan limits, and the grace period ends on ${endsOn}.`,
        },
        ...overBlocks,
        {
          kind: "p",
          text: "When it ends, new shared documents and projects on this workspace will be paused. Existing links keep working, and you can still add links to the documents you already share.",
        },
        ...howToFix,
      ),
    });
  }

  return transactional({
    subject: "New documents are paused on this workspace",
    preheader: "Existing links keep working and nothing has been deleted.",
    blocks: blocks(
      { kind: "heading", text: `New documents are paused on "${name}"` },
      {
        kind: "p",
        text: `The grace period ended on ${endsOn} and the workspace is still over the Free plan limits, so sharing new documents and creating projects are paused for now.`,
      },
      ...overBlocks,
      { kind: "p", text: "Your existing links keep working and nothing has been deleted." },
      {
        kind: "p",
        text: "To pick up where you left off, bring the workspace back under the limits (archive a document, archive a project, or remove a collaborator) and creating resumes immediately.",
      },
      { kind: "action", label: "Upgrade to Pro", url: pricingUrl },
    ),
  });
}

/**
 * Send one plan-limit grace email to a workspace owner.
 *
 * Throws when the transport fails (callers isolate per workspace). Honours
 * `EMAIL_TRANSPORT=console` via `sendTextEmail`.
 */
export async function sendPlanLimitEmail(params: SendPlanLimitEmailParams): Promise<void> {
  const { subject, text, html } = buildPlanLimitEmail(params);
  await sendTextEmail({ to: params.to, subject, text, ...(html ? { html } : {}) });
}
