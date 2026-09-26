/**
 * Every project-, document- and upload-shaped read in `src/` is classified, and an unclassified one
 * fails (docs/prds/lnkdrp-locked-projects.md, decisions 7 and 13, Verification 3).
 *
 * This is a source contract in the idiom of `tests/lib/containedDocListings.test.ts`, and it is the
 * PRIMARY mechanism of the whole feature, not its documentation. The required `viewerUserId` on the
 * four `src/lib/projects/scope.ts` builders and the required exclusion argument on `buildDocMatch`
 * are real help and they are not the guarantee: the type-checker only ever enumerates the call sites
 * that go through a shared helper, and a new `DocModel.find` in a new route goes through nothing.
 * The rest is carried here.
 *
 * Each file that reads projects, documents or uploads carries a state and a count:
 *
 * - `filtered` — its viewer-facing reads carry the rule, inherited from `src/lib/projects/scope.ts`,
 *   `src/lib/projects/lockScope.ts` or `src/lib/projects/names.ts` rather than restated. The file
 *   must import one of those three.
 * - `inherited` — the read is bounded by a document or a project the route has ALREADY resolved
 *   through the rule, so the row cannot be reached without passing it. The upload rows of one
 *   document, the page counts of an already-filtered document list, a project's own analytics.
 * - `recipient_exempt` — recipient-side, and deliberately lock-free (decision 25). A data room's
 *   public link is how the product works and it keeps working whether the room is locked or not, so
 *   these must NOT import `lockScope`; `tests/lib/lockedProjectRecipients.test.ts` asserts that.
 * - `admin_exempt` — platform admin's cross-workspace read, kept for support (decision 22). This is
 *   the most dangerous list in the file, because adding an entry is a one-line way to turn the lock
 *   off for a surface, so every entry states its reason and the failure message prints it.
 * - `lock_free` — a read that must see every row for a reason that is neither admin nor recipient:
 *   the plan cap (decision 29), the workspace-unique name and slug probes, the purge sweep, the
 *   request-inbox list (decision 9), a cron rollup with no viewer at all, and the helpers that
 *   compute the hidden sets themselves.
 * - `deferred` — not yet filtered, with the milestone that converts it. This list is what makes the
 *   contract honest during a staged rollout, and nothing is lockable from the UI until M7 precisely
 *   because entries remain in it.
 *
 * The counts are the grep. A new read anywhere in `src/` changes a count and fails here, which
 * forces whoever added it to say which of the six answers it is.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, test } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const SRC = path.join(ROOT, "src");

/**
 * The three read patterns, each with a lookbehind so a differently-named model is not counted.
 *
 * Without it `StarredDocModel.find(` counts as a `DocModel` read, which is how a table like this
 * ends up recording a number nobody can reproduce by eye.
 */
const PROJECT_READ_RX = /(?<![A-Za-z])ProjectModel\.(find|findOne|findById|countDocuments|aggregate|exists)\s*\(/g;
const DOC_READ_RX = /(?<![A-Za-z])DocModel\.(find|aggregate)\s*\(/g;
const UPLOAD_READ_RX = /(?<![A-Za-z])UploadModel\.(find|aggregate)\s*\(/g;

/** Any of the three places the rule is allowed to come from. */
const RULE_IMPORT_RX = /from\s*["']@\/lib\/projects\/(scope|lockScope|names)["']/;

type State = "filtered" | "inherited" | "recipient_exempt" | "admin_exempt" | "lock_free" | "deferred";

type Entry = {
  /** How many read call sites of this model the file holds today. */
  reads: number;
  state: State;
  /** Why, in one sentence. Printed on failure. */
  why: string;
  /** For `deferred` only: the milestone that converts it. */
  milestone?: string;
};

// ---------------------------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------------------------

const PROJECT_SURFACES: Record<string, Entry> = {
  // --- filtered ---------------------------------------------------------------------------------
  "src/app/api/projects/route.ts": {
    reads: 4,
    state: "filtered",
    why: "the list and its total build on liveProjectFilter; the two remaining `exists` calls are the workspace-unique name and slug probes, which cannot be per viewer",
  },
  "src/app/api/projects/[projectSlug]/route.ts": {
    reads: 8,
    state: "filtered",
    why: "GET by id, GET by slug, PATCH, DELETE and the slug_backfill_pending probe all build on scope.ts; the three `exists` calls are the uniqueness probes and the `findById` re-reads a row already resolved through the filter",
  },
  "src/app/api/projects/[projectSlug]/docs/route.ts": {
    reads: 1,
    state: "filtered",
    why: "the project gate for its document listing",
  },
  "src/app/api/projects/[projectSlug]/suggested-docs/route.ts": {
    reads: 1,
    state: "filtered",
    why: "the project gate for the workspace documents it suggests",
  },
  "src/app/api/projects/[projectSlug]/links/shared.ts": {
    reads: 1,
    state: "filtered",
    why: "accessProjectForLinks, where one clause covers seven routes and lands before the legacy-adopt updateOne",
  },
  "src/app/api/sidebar/route.ts": {
    reads: 4,
    state: "filtered",
    why: "the project half imports liveProjectFilter rather than restating it, which is where a locked room would appear first; the request half is request repos, which cannot be locked",
  },
  "src/app/api/metrics/events/route.ts": {
    reads: 2,
    state: "filtered",
    why: "both project branches prove visibility before writing, so the presence of the check is not an existence oracle for any project id",
  },
  "src/lib/projects/resolveProject.ts": {
    reads: 1,
    state: "filtered",
    why: "the one id-or-slug read the routes hanging off /api/projects/:id share (members, lock-review), built from scope.ts so all three answer a locked room exactly as the project route does",
  },
  "src/app/api/requests/[token]/guide/route.ts": {
    reads: 1,
    state: "filtered",
    why: "a request inbox can never be locked (decision 10), so the clause is inert here; it goes through scope.ts because that is the one project rule this file is allowed to use",
  },
  "src/app/api/docs/[docId]/route.ts": {
    reads: 4,
    state: "filtered",
    why: "the two room-pill hydrations and the countDocuments that authorizes filing a document into projects all carry the visibility clause (decisions 14 and 27); the fourth is the request-inbox backlink probe, and an inbox cannot be locked",
  },
  "src/app/api/docs/route.ts": {
    reads: 2,
    state: "filtered",
    why: "POST resolves the home project through the clause and answers the existing PROJECT_NOT_FOUND (decision 27); the other read is the request-inbox backlink probe",
  },
  "src/app/api/dashboard/stats/route.ts": {
    reads: 1,
    state: "filtered",
    why: "the projectsActive tile counts only the rooms this caller may see, so it cannot disagree with /api/projects (decision 16)",
  },
  "src/app/api/orgs/[orgId]/route.ts": {
    reads: 1,
    state: "filtered",
    why: "the workspace's project count, per viewer, because an admin is not exempt (decisions 16 and 21)",
  },
  "src/app/api/tags/assignments/route.ts": {
    reads: 1,
    state: "filtered",
    why: "targetIsInWorkspace had no visibility notion of any kind, which made tagging a room an oracle for it and then printed the room on the tag's page",
  },
  "src/app/api/tags/by-slug/[slug]/items/route.ts": {
    reads: 1,
    state: "filtered",
    why: "tags target projects too, so this listing names rooms",
  },
  "src/app/api/uploads/[uploadId]/process/route.ts": {
    reads: 3,
    state: "filtered",
    why: "the auto-routing candidate set is the uploader's visible set, so the model is never told a locked room exists (decision 27); the other two are request-inbox probes",
  },
  "src/lib/contacts/service.ts": {
    reads: 1,
    state: "filtered",
    why: "the contact detail names only the rooms this reader may see, and ?projectId= refuses a hidden one as empty (decision 15)",
  },
  "src/lib/projects/names.ts": {
    reads: 1,
    state: "filtered",
    why: "the one read behind projectNamesFor, which is where about a dozen hand-written name hydrations now come from (decision 14)",
  },

  // --- recipient_exempt: nothing changes for recipients (decision 25) --------------------------
  "src/lib/share/projectLinks.ts": {
    reads: 3,
    state: "recipient_exempt",
    why: "tenancy is derived from the slug and there is no actor to check; findProject() is the one owner-side lookup here and takes the clause in M3",
  },
  "src/app/api/requests/[token]/uploads/route.ts": {
    reads: 1,
    state: "recipient_exempt",
    why: "inbound recipient uploads, gated by a capability token; a member clause here breaks the feature",
  },
  "src/app/api/request-view/[token]/docs/[docId]/pdf/route.ts": {
    reads: 1,
    state: "recipient_exempt",
    why: "the view-only recipient route for a request inbox",
  },
  "src/app/r/[token]/page.tsx": {
    reads: 1,
    state: "recipient_exempt",
    why: "the recipient upload page for a request link",
  },
  "src/app/request-view/[token]/page.tsx": {
    reads: 1,
    state: "recipient_exempt",
    why: "the recipient view page for a request link",
  },

  // --- admin_exempt: platform support, deliberately (decision 22) ------------------------------
  // Every entry here turns the lock OFF for that surface. The promise is therefore worded as
  // "nobody else in your workspace", never "nobody else", and the admin UI labels a locked room.
  "src/app/api/admin/data/projects/route.ts": {
    reads: 2,
    state: "admin_exempt",
    why: "platform admin's cross-workspace project browser, kept for support",
  },
  "src/app/api/admin/data/projects/[projectId]/route.ts": {
    reads: 2,
    state: "admin_exempt",
    why: "platform admin's single-project read and write, kept for support",
  },
  "src/app/api/admin/data/requests/route.ts": {
    reads: 2,
    state: "admin_exempt",
    why: "platform admin's request-inbox browser; request inboxes cannot be locked anyway",
  },
  "src/app/api/admin/data/requests/[requestId]/route.ts": {
    reads: 1,
    state: "admin_exempt",
    why: "platform admin's single request-inbox read",
  },
  "src/app/api/admin/data/links/route.ts": {
    reads: 1,
    state: "admin_exempt",
    why: "platform admin hydrates project names for the links browser",
  },

  // --- lock_free: must see every row, for a reason that is neither admin nor recipient ---------
  "src/lib/billing/planLimits.ts": {
    reads: 1,
    state: "lock_free",
    why: "the plan cap counts what exists through allProjectsFilter, because applying the lock there would make Free unlimited by locking (decision 29)",
  },
  "src/app/api/requests/route.ts": {
    reads: 3,
    state: "lock_free",
    why: "the request inbox list is deliberately lock-free: a request inbox can never be locked (decisions 9 and 10)",
  },
  "src/lib/accounts/purge.ts": {
    reads: 1,
    state: "lock_free",
    why: "a purge deletes a whole workspace and has to see every row; it clears grants rather than filtering",
  },
  "src/lib/projects/lockScope.ts": {
    reads: 1,
    state: "lock_free",
    why: "the helper that computes the locked set; filtering it with itself is the circular version of the rule",
  },
  "src/lib/slack/outbox.ts": {
    reads: 1,
    state: "lock_free",
    why: "routing asks which of an event's rooms are locked so a locked room posts only to its own channel and never to the catch-all (decision 20); there is no viewer on this path, and the question IS the lock",
  },
  "src/lib/visits/visitBriefs.ts": {
    reads: 1,
    state: "lock_free",
    why: "the brief's feed row carries projectId, so under the feed rule (decision 17) the name it stores is read back only by the room's own members; there is no viewer on this path, and the fix decision 14 asks for here was the missing orgId, which it now has",
  },

  // --- deferred: the milestone that converts each one ------------------------------------------
  "src/lib/slack/messages.ts": {
    reads: 3,
    state: "deferred",
    why: "the room name and the /project/:slug URL Slack builds, which routing stops handing a target to",
    milestone: "M5",
  },
};

/** The total `deferred` project reads, pinned so the list can only shrink on purpose. */
const DEFERRED_PROJECT_READS = 3;

// ---------------------------------------------------------------------------------------------
// Documents (decisions 11 and 13)
// ---------------------------------------------------------------------------------------------

const DOC_SURFACES: Record<string, Entry> = {
  // --- filtered ---------------------------------------------------------------------------------
  "src/app/api/docs/route.ts": {
    reads: 1,
    state: "filtered",
    why: "the list, with the exclusion spread UNCONDITIONALLY: outside the `if (!addressing)` guard, because the lock is access and not discovery (decision 11)",
  },
  "src/app/api/changes/route.ts": {
    reads: 1,
    state: "filtered",
    why: "every row carries the document's shareId, which is the document (decision 13); the exclusion is on all three branches of the document filter",
  },
  "src/app/api/sidebar/route.ts": {
    reads: 1,
    state: "filtered",
    why: "Recent documents, fixed beside the project half because the sidebar is where a private room shows up first",
  },
  "src/app/api/projects/[projectSlug]/suggested-docs/route.ts": {
    reads: 1,
    state: "filtered",
    why: "a workspace-wide document listing with a project's tags for a query; a document homed in a private room must not be offered for filing elsewhere",
  },
  "src/app/api/projects/[projectSlug]/docs/route.ts": {
    reads: 1,
    state: "filtered",
    why: "the project's own listing still hides a document whose HOME is another, private room (decision 12's sharp edge), because its own page answers 404",
  },
  "src/app/api/starred/route.ts": {
    reads: 1,
    state: "filtered",
    why: "a starred document whose room this person has left drops out of the list; the star row survives, as it does for a delete",
  },
  "src/app/api/starred/bootstrap/route.ts": {
    reads: 1,
    state: "filtered",
    why: "the same rule on the way in: a document this caller cannot see cannot be starred by a bootstrap payload",
  },
  "src/app/api/tags/[tag]/docs/route.ts": {
    reads: 1,
    state: "filtered",
    why: "AI tag documents, which carry titles and shareIds (decision 13)",
  },
  "src/app/api/tags/by-slug/[slug]/items/route.ts": {
    reads: 1,
    state: "filtered",
    why: "the workspace tag page, the one place documents and rooms meet, so one missing clause would leak both",
  },
  "src/app/api/tags/targets/route.ts": {
    reads: 1,
    state: "filtered",
    why: "two hundred arbitrary ids answered per id whether the workspace has anything filed about them; ids the caller cannot see never reach the assignment read",
  },
  "src/app/api/uploads/route.ts": {
    reads: 2,
    state: "filtered",
    why: "the title search and the document join that replaced `populate`, because each row carries the document's present-day title and its public shareId (decision 13)",
  },
  "src/app/api/uploads/in-progress/route.ts": {
    reads: 2,
    state: "filtered",
    why: "both title reads; a row whose document does not resolve is already dropped for want of a name",
  },
  "src/app/api/dashboard/stats/route.ts": {
    reads: 1,
    state: "filtered",
    why: "the document facet behind every tile, beside the $expr twin of the same rule in the ShareView $lookup (decision 16)",
  },
  "src/app/api/activity/route.ts": {
    reads: 1,
    state: "filtered",
    why: "the feed's title and shareId hydration (decision 13); which feed ROWS a non-member sees is M4's separate job",
  },
  "src/lib/analytics/workspace/query.ts": {
    reads: 1,
    state: "filtered",
    why: "the document set every figure on /metrics is derived from, with the caller's visible set in the route's cache key (decision 16)",
  },
  "src/lib/contacts/service.ts": {
    reads: 1,
    state: "filtered",
    why: "the contact detail's documents, and ?docId= filtered through the document's home (decision 15)",
  },
  "src/lib/people/profile.ts": {
    reads: 1,
    state: "filtered",
    why: "a contributor's documents; one in a room the reader is outside reads exactly like a purged one, which is the shape those two must share",
  },

  // --- inherited: bounded by something already resolved through the rule ------------------------
  "src/app/api/projects/[projectSlug]/route.ts": {
    reads: 2,
    state: "inherited",
    why: "the home-document set and the request-repo document set of one project, already resolved through the visibility clause by the handler above them",
  },
  "src/app/api/projects/[projectSlug]/shareviews/route.ts": {
    reads: 2,
    state: "inherited",
    why: "one project's analytics, reached only through accessProjectForLinks",
  },
  "src/app/api/projects/[projectSlug]/shareviews/visits/route.ts": {
    reads: 1,
    state: "inherited",
    why: "the same project analytics gate, one route over",
  },
  "src/lib/projects/lockReview.ts": {
    reads: 1,
    state: "inherited",
    why: "the review describes one specific room the caller has already resolved and is about to lock, so it needs the counts unfiltered to be able to state them",
  },

  // --- recipient_exempt -------------------------------------------------------------------------
  "src/lib/share/projectPublic.ts": {
    reads: 1,
    state: "recipient_exempt",
    why: "the public data room's own document list, for an anonymous visitor with no identity to hold a grant",
  },
  "src/app/request-view/[token]/page.tsx": {
    reads: 1,
    state: "recipient_exempt",
    why: "the recipient view page for a request link",
  },

  // --- admin_exempt -----------------------------------------------------------------------------
  "src/app/api/admin/data/docs/route.ts": {
    reads: 1,
    state: "admin_exempt",
    why: "platform admin's cross-workspace document browser, kept for support",
  },
  "src/app/api/admin/data/uploads/route.ts": {
    reads: 1,
    state: "admin_exempt",
    why: "platform admin hydrates document titles for the uploads browser",
  },
  "src/app/api/admin/data/links/route.ts": {
    reads: 1,
    state: "admin_exempt",
    why: "platform admin hydrates document titles for the links browser",
  },
  "src/app/api/admin/data/requests/[requestId]/route.ts": {
    reads: 1,
    state: "admin_exempt",
    why: "platform admin's view of one request inbox's documents",
  },

  // --- lock_free --------------------------------------------------------------------------------
  "src/lib/docs/visibility.ts": {
    reads: 1,
    state: "lock_free",
    why: "containedDocIds, the containment helper; the lock is a separate rule and this one must keep seeing every contained row",
  },
  "src/lib/accounts/purge.ts": {
    reads: 1,
    state: "lock_free",
    why: "a purge deletes a whole workspace and has to see every row",
  },
  "src/app/api/auth/claim-temp/route.ts": {
    reads: 1,
    state: "lock_free",
    why: "moves a temp user's own documents into the account they just created, keyed on that temp userId; there is no workspace and no room in the picture yet",
  },
  "src/lib/metrics/rollupDocMetrics.ts": {
    reads: 1,
    state: "lock_free",
    why: "a cron rollup that recomputes a workspace's own stored counters; there is no viewer, and a locked room's own members read the result",
  },
  "src/lib/credits/summaryRequeue.ts": {
    reads: 1,
    state: "lock_free",
    why: "requeues the workspace's skipped summaries when its subscription becomes billable; the credit belongs to the workspace rather than to a person, and a locked room's members are the ones who would otherwise keep a blank summary (see queueSummaryRerun)",
  },

  // --- deferred ---------------------------------------------------------------------------------
  "src/lib/notifications/sendNotificationEmails.ts": {
    reads: 3,
    state: "deferred",
    why: "the document titles a digest names; the audience these emails go to is what M5 narrows, and filtering the titles without the audience would send a member of a room an email with the titles stripped out",
    milestone: "M5",
  },
  "src/lib/notifications/viewNotifications.ts": {
    reads: 1,
    state: "deferred",
    why: "the view-notification composer's document read, converted with the four fanout sites",
    milestone: "M5",
  },
  "src/lib/visits/visitBriefs.ts": {
    reads: 1,
    state: "deferred",
    why: "the visit's own documents, read while the brief is written; the brief's audience and its fallback actor are M5",
    milestone: "M5",
  },
};

/** The total `deferred` document reads. */
const DEFERRED_DOC_READS = 5;

// ---------------------------------------------------------------------------------------------
// Uploads (decision 13: titles and versions, scoped by orgId alone)
// ---------------------------------------------------------------------------------------------

const UPLOAD_SURFACES: Record<string, Entry> = {
  "src/app/api/uploads/route.ts": {
    reads: 1,
    state: "filtered",
    why: "the listing itself; its document join carries the rule, and a row whose document is hidden is dropped rather than blanked",
  },

  "src/app/api/uploads/in-progress/route.ts": {
    reads: 1,
    state: "inherited",
    why: "in-flight rows, kept only when their document resolved through the filtered title read beside them",
  },
  "src/app/api/docs/[docId]/changes/route.ts": {
    reads: 2,
    state: "inherited",
    why: "the version rows of one document, already resolved through buildDocMatch",
  },
  "src/app/api/docs/[docId]/route.ts": {
    reads: 1,
    state: "inherited",
    why: "the version history of one document, already resolved through buildDocMatch",
  },
  "src/app/api/docs/route.ts": {
    reads: 1,
    state: "inherited",
    why: "current version numbers for the documents the list has already filtered",
  },
  "src/app/api/sidebar/route.ts": {
    reads: 1,
    state: "inherited",
    why: "current version numbers for the recent documents the list has already filtered",
  },
  "src/app/api/projects/[projectSlug]/docs/route.ts": {
    reads: 1,
    state: "inherited",
    why: "version numbers for the project's already-filtered document list",
  },
  "src/lib/analytics/workspace/query.ts": {
    reads: 1,
    state: "inherited",
    why: "page counts for the already-filtered document set, used only as a reading-badge denominator",
  },
  "src/lib/projects/lockReview.ts": {
    reads: 1,
    state: "inherited",
    why: "the counts for the one room the caller is about to lock and can already see",
  },

  "src/app/api/admin/data/uploads/route.ts": {
    reads: 1,
    state: "admin_exempt",
    why: "platform admin's cross-workspace uploads browser, kept for support",
  },
  "src/app/api/admin/data/docs/[docId]/route.ts": {
    reads: 1,
    state: "admin_exempt",
    why: "platform admin's version history for one document",
  },
  "src/app/api/admin/data/requests/[requestId]/route.ts": {
    reads: 1,
    state: "admin_exempt",
    why: "platform admin's view of one request inbox's uploads",
  },

  "src/lib/accounts/purge.ts": {
    reads: 2,
    state: "lock_free",
    why: "a purge deletes a whole workspace and has to see every row",
  },
  "src/app/api/uploads/[uploadId]/process/route.ts": {
    reads: 1,
    state: "lock_free",
    why: "the processing job reading its own upload's siblings; it acts for the uploader, whose access was decided when the upload row was created",
  },
  "src/lib/credits/summaryRequeue.ts": {
    reads: 1,
    state: "lock_free",
    why: "the workspace's skipped summaries, for the same reason as its document read",
  },

  "src/app/api/dashboard/stats/route.ts": {
    reads: 1,
    state: "deferred",
    why: "the uploads-per-day chart line counts by orgId, so an upload into a private room still moves it; an Upload row carries no project, so this needs the $expr join the ShareView stage beside it already has",
    milestone: "M4",
  },
  "src/lib/notifications/sendNotificationEmails.ts": {
    reads: 2,
    state: "deferred",
    why: "the version rows a digest names, converted with the audience in M5",
    milestone: "M5",
  },
};

/** The total `deferred` upload reads. */
const DEFERRED_UPLOAD_READS = 3;

// ---------------------------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------------------------

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(p);
    else if (/\.tsx?$/.test(entry.name)) yield p;
  }
}

/** Every file under `src/` matching one read pattern, and how many sites it holds. */
function scan(rx: RegExp): Map<string, number> {
  const found = new Map<string, number>();
  for (const file of sourceFiles(SRC)) {
    const src = readFileSync(file, "utf8");
    const hits = src.match(rx);
    if (!hits) continue;
    found.set(path.relative(ROOT, file).split(path.sep).join("/"), hits.length);
  }
  return found;
}

function source(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

function describeEntry(file: string, e: Entry): string {
  return `${file} [${e.state}${e.milestone ? ` ${e.milestone}` : ""}]: ${e.why}`;
}

/** The three tables get identical treatment, so the assertions are written once. */
function contractFor(params: { label: string; rx: RegExp; table: Record<string, Entry>; deferred: number }): void {
  const { label, table } = params;

  describe(`every ${label} read is classified`, () => {
    const found = scan(params.rx);

    it(`no file reads ${label}s without saying which of the six answers it is`, () => {
      const unclassified = [...found.keys()].filter((f) => !table[f]);
      expect(
        unclassified,
        [
          `A new ${label} read appeared in a file this contract does not classify.`,
          "Add it with one of: filtered, inherited, recipient_exempt, admin_exempt, lock_free, deferred.",
          "A read that resolves a row FOR A PERSON belongs in `filtered`, which means carrying the rule",
          "from src/lib/projects/scope.ts, lockScope.ts or names.ts rather than by hand.",
          ...unclassified.map((f) => `  unclassified: ${f}`),
        ].join("\n"),
      ).toEqual([]);
    });

    it(`no classified file has stopped reading ${label}s`, () => {
      const stale = Object.keys(table).filter((f) => !found.has(f));
      expect(stale, `these files no longer read ${label}s and should leave the table:\n${stale.join("\n")}`).toEqual([]);
    });

    it("each file holds exactly the number of reads this contract records", () => {
      const drift = [...found.entries()]
        .filter(([f, n]) => table[f] && table[f].reads !== n)
        .map(([f, n]) => `  ${f}: records ${table[f].reads}, found ${n} (${describeEntry(f, table[f])})`);
      expect(
        drift,
        [
          `A ${label} read was added to or removed from a file this contract already classifies.`,
          "Update the count, and say whether the new read carries the rule or belongs in one of the",
          "exempt lists. The count IS the grep: without it a new unfiltered read hides inside a",
          "file that is already accounted for.",
          ...drift,
        ].join("\n"),
      ).toEqual([]);
    });

    it("every filtered surface inherits the rule instead of restating it", () => {
      const offenders = Object.entries(table)
        .filter(([, e]) => e.state === "filtered")
        .filter(([file]) => !RULE_IMPORT_RX.test(source(file)))
        .map(([file, e]) => describeEntry(file, e));
      expect(
        offenders,
        `these are recorded as filtered but import none of scope.ts, lockScope.ts or names.ts:\n${offenders.join("\n")}`,
      ).toEqual([]);
    });

    it("every deferred surface names the milestone that converts it, and only deferred ones do", () => {
      const nameless = Object.entries(table)
        .filter(([, e]) => e.state === "deferred" && !e.milestone)
        .map(([f]) => f);
      expect(nameless, `a deferred surface with no milestone is a dumping ground:\n${nameless.join("\n")}`).toEqual([]);
      const wrong = Object.entries(table)
        .filter(([, e]) => e.state !== "deferred" && e.milestone)
        .map(([f]) => f);
      expect(wrong).toEqual([]);
    });

    it("the unfiltered read count only moves when somebody means it to", () => {
      const total = Object.values(table)
        .filter((e) => e.state === "deferred")
        .reduce((sum, e) => sum + e.reads, 0);
      expect(
        total,
        "This number should go DOWN as milestones land. If it went up, a new read was parked in `deferred` instead of carrying the rule.",
      ).toBe(params.deferred);
    });

    it("every entry states a reason", () => {
      const silent = Object.entries(table)
        .filter(([, e]) => e.why.trim().length < 20)
        .map(([f]) => f);
      expect(silent).toEqual([]);
    });
  });
}

contractFor({ label: "project", rx: PROJECT_READ_RX, table: PROJECT_SURFACES, deferred: DEFERRED_PROJECT_READS });
contractFor({ label: "document", rx: DOC_READ_RX, table: DOC_SURFACES, deferred: DEFERRED_DOC_READS });
contractFor({ label: "upload", rx: UPLOAD_READ_RX, table: UPLOAD_SURFACES, deferred: DEFERRED_UPLOAD_READS });

// ---------------------------------------------------------------------------------------------
// The shapes the tables cannot express
// ---------------------------------------------------------------------------------------------

describe("the filtered project surfaces do not hand-roll the rule", () => {
  it("no filtered surface restates the request-repo half of liveProjectFilter", () => {
    // The shape of the copy `/api/sidebar` used to carry. A file that restates this is not
    // inheriting the visibility clause either, however filtered its imports look.
    const offenders = Object.entries(PROJECT_SURFACES)
      .filter(([, e]) => e.state === "filtered")
      .filter(([file]) => file !== "src/app/api/requests/route.ts")
      .filter(([file]) => source(file).includes("{ $or: [{ isRequest: { $exists: false } }, { isRequest: { $ne: true } }] }"))
      .map(([file]) => file);
    expect(
      offenders,
      `these files restate the liveProjectFilter rule instead of importing it:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

describe("the plan cap and the list disagree on purpose", () => {
  const src = source("src/lib/billing/planLimits.ts");

  it("planLimits.ts imports allProjectsFilter", () => {
    expect(src).toMatch(/import\s*\{[^}]*\ballProjectsFilter\b[^}]*\}\s*from\s*["']@\/lib\/projects\/scope["']/);
    expect(src).toContain("ProjectModel.countDocuments(allProjectsFilter(id))");
  });

  it("planLimits.ts does not import liveProjectFilter", () => {
    // Applying the visibility clause to the cap makes the Free plan unlimited by locking, which is
    // the one direction this divergence is allowed to run (decision 29).
    expect(src).not.toContain("liveProjectFilter");
  });

  it("allProjectsFilter carries no visibility term at all", () => {
    const scope = source("src/lib/projects/scope.ts");
    const body = scope.slice(
      scope.indexOf("export function allProjectsFilter"),
      scope.indexOf("export async function liveProjectFilter"),
    );
    expect(body).not.toContain("visibility");
    expect(body).not.toContain("projectGrantIds");
  });
});

/**
 * The by-id half of the feature (decision 11), which no count can express: `buildDocMatch` is what
 * about twenty routes resolve a named document through, so the exclusion has to be an argument they
 * cannot leave out.
 */
describe("buildDocMatch carries the locked-room exclusion, and it is required", () => {
  const src = source("src/lib/docs/docMatch.ts");

  it("takes the exclusion as a required fifth parameter", () => {
    expect(src).toContain("lockedExclusion: Record<string, unknown>,");
    // Not optional, and not defaulted: an argument that can be omitted is one a new route omits.
    expect(src).not.toMatch(/lockedExclusion\?:/);
    expect(src).not.toMatch(/lockedExclusion: Record<string, unknown> =/);
  });

  it("lands it in `$and`, and adds nothing at all when there is nothing to hide", () => {
    expect(src).toContain("Object.keys(lockedExclusion).length > 0 ? { $and: [lockedExclusion] } : {}");
  });

  it("stays pure, so the caller does the grant read and the filter tests can rebuild it", () => {
    // The body only: both docstrings name the helper the caller is expected to await, on purpose.
    const body = src.slice(src.indexOf("): Record<string, unknown> {"));
    expect(body).not.toContain("await ");
    expect(body).not.toContain("hiddenProjectIds");
    expect(src).not.toContain('from "@/lib/projects/lockScope"');
  });

  it("every file that builds a document match passes something for it", async () => {
    const { buildDocMatch } = await import("@/lib/docs/docMatch");
    const { lockedHomeExclusion } = await import("@/lib/projects/lockScope");
    const { Types } = await import("mongoose");
    const doc = new Types.ObjectId();
    const org = new Types.ObjectId();
    const me = new Types.ObjectId();
    const hidden = new Types.ObjectId();

    // Nothing hidden: byte-identical to the filter this function returned before the feature existed.
    expect(buildDocMatch(doc, org, me, false, {})).toEqual({ _id: doc, orgId: org, isDeleted: { $ne: true } });
    // Something hidden: the same filter plus one `$and`, and the legacy `$or` still there.
    const legacy = buildDocMatch(doc, org, me, true, lockedHomeExclusion([hidden]));
    expect(Object.keys(legacy).sort()).toEqual(["$and", "$or", "isDeleted"]);
    expect((legacy.$or as unknown[]).length).toBe(2);
  });
});

/**
 * `GET /api/docs` is where the lock and containment deliberately disagree, so the difference is
 * pinned rather than described. `tests/lib/containedDocListings.test.ts` owns the guarded half.
 */
describe("GET /api/docs closes the addressing path for the lock and not for containment", () => {
  const src = source("src/app/api/docs/route.ts");
  const get = src.slice(src.indexOf("export async function GET"), src.indexOf("export async function POST"));

  it("containment stays on the browse path only", () => {
    expect(get).toMatch(/if \(!addressing\) Object\.assign\(filter, workspaceListableDocFilter\(\)\)/);
  });

  it("the lock is applied unconditionally, after that guard", () => {
    expect(get).toMatch(/Object\.assign\(filter, await lockedHomeExclusionFor\(orgId, actor\.userId, request\)\)/);
    const lockAt = get.indexOf("lockedHomeExclusionFor");
    const guardAt = get.indexOf("if (!addressing) Object.assign(filter, workspaceListableDocFilter())");
    expect(guardAt).toBeGreaterThan(-1);
    expect(lockAt).toBeGreaterThan(guardAt);
    // The lock line must not be inside the guard: `?ids=` and an exact `?q=` close here.
    expect(get).not.toMatch(/if \(!addressing\)[^\n]*lockedHomeExclusionFor/);
  });
});

/** Decision 13's four surfaces, each of which returns a `shareId` and had no clause at all. */
describe("a shareId in a workspace-side payload is filtered like the document it opens", () => {
  it("searchShareLinks takes the caller and drops hidden projects and hidden homes", () => {
    const src = source("src/lib/share/links.ts");
    expect(src).toContain("viewerUserId: string | Types.ObjectId;");
    expect(src).toContain("hiddenProjectIds(orgId, input.viewerUserId, input.request)");
    // Both halves: the link's own project, and the link's document's home.
    expect(src).toContain('{ "project._id": { $nin: hidden } }');
    expect(src).toContain('lockedHomeExclusion(hidden, "doc")');
  });

  it("the share-link search route passes the caller", () => {
    expect(source("src/app/api/share-links/route.ts")).toContain("viewerUserId: actor.userId");
  });

  it("the prefixed form of the exclusion is the same rule, not a second copy", async () => {
    const { lockedHomeExclusion } = await import("@/lib/projects/lockScope");
    const { Types } = await import("mongoose");
    const hidden = [new Types.ObjectId()];
    expect(lockedHomeExclusion([])).toEqual({});
    expect(lockedHomeExclusion([], "doc")).toEqual({});
    expect(lockedHomeExclusion(hidden)).toEqual({
      $nor: [{ primaryProjectId: { $in: hidden } }, { primaryProjectId: null, projectIds: { $in: hidden } }],
    });
    expect(lockedHomeExclusion(hidden, "doc")).toEqual({
      $nor: [{ "doc.primaryProjectId": { $in: hidden } }, { "doc.primaryProjectId": null, "doc.projectIds": { $in: hidden } }],
    });
  });
});

/**
 * The counting surfaces (decision 16). The dashboard's `$lookup` speaks only in aggregation
 * expressions, so the rule has an `$expr` twin, and the analytics cache key is an acceptance
 * criterion rather than a footnote.
 */
describe("the counting surfaces", () => {
  it("the dashboard ShareView $lookup carries the $expr twin beside the containment one", () => {
    const src = source("src/app/api/dashboard/stats/route.ts");
    expect(src).toContain('{ $ne: ["$visibility", "project"] }');
    expect(src).toContain("...lockedHomeExclusionExpr(hidden)");
  });

  it("the $expr twin says the same thing as the plain form", async () => {
    const { lockedHomeExclusionExpr } = await import("@/lib/projects/lockScope");
    const { Types } = await import("mongoose");
    expect(lockedHomeExclusionExpr([])).toEqual([]);
    const hidden = [new Types.ObjectId()];
    const terms = lockedHomeExclusionExpr(hidden);
    // One term per arm of the `$nor`, so the pair reads as the rule it mirrors.
    expect(terms).toHaveLength(2);
    expect(JSON.stringify(terms)).toContain("$primaryProjectId");
    expect(JSON.stringify(terms)).toContain("$projectIds");
  });

  it("the workspace metrics cache key carries the caller's visible set", () => {
    const src = source("src/app/api/metrics/workspace/route.ts");
    // A hash of the hidden set, not the caller's id: with no locked room the suffix is empty and the
    // whole workspace still shares one entry, which is what keeps this free where it always was.
    expect(src).toContain("hiddenProjectIds(actor.orgId, actor.userId, request)");
    expect(src).toContain("const cacheKey = `${actor.orgId}:${requestedRange}:${plan}:${visibleSetKey}`");
  });

  it("the workspace metrics loader requires a viewer", () => {
    expect(source("src/lib/analytics/workspace/query.ts")).toContain("viewerUserId: string | Types.ObjectId;");
  });
});

/** Decision 15: the surface every design in review missed. */
describe("contacts are filtered like the recipient-identity surface they are", () => {
  const src = source("src/lib/contacts/service.ts");

  it("the filter builder takes the caller", () => {
    expect(src).toContain("export type ContactViewer");
    expect(src).toContain("viewer: ContactViewer,");
  });

  it("?projectId= on a hidden room answers nothing, without a query", () => {
    expect(src).toContain("if (hidden.some((hiddenId) => String(hiddenId) === String(id))) return null;");
  });

  it("?docId= is filtered through the document's home", () => {
    expect(src).toContain("DocModel.exists({ _id: id, orgId, ...lockedHomeExclusion(hidden) })");
  });

  it("the list, the counts and the CSV all go through that one builder", () => {
    expect(src.match(/buildFilter\(orgId, params, params\)/g) ?? []).toHaveLength(3);
  });

  it("the detail builds its lists from what came back, not from the ids on the row", () => {
    // The `shareId` on a source row came from the contact, not from the document read, so filtering
    // the read alone would have left a live link to a private room with its title removed.
    expect(src).toContain(".filter((s) => (s.docId ? titles.has(String(s.docId)) : true))");
    expect(src).toContain(".filter((s) => (s.projectId ? names.has(String(s.projectId)) : true))");
    expect(src).toContain(".filter((id) => titles.has(String(id)))");
    expect(src).toContain(".filter((id) => names.has(String(id)))");
  });
});

/** Decision 14: one helper produces every room name, and it tenants the three that had no clause. */
describe("a locked room's name comes from one helper", () => {
/**
   * The hydrations decision 14 names, and whether the file is allowed to keep a project read of its
   * own afterwards.
   *
   * `keepsOwnRead` is true only for a file whose remaining reads are something else entirely and are
   * classified above: the upload processor still reads projects for the auto-routing candidate set and
   * for its request-inbox probes. Everywhere else the name read WAS the only project read, so "no
   * `ProjectModel` in this file" is the strongest available statement that the copy is gone.
   */
  const NAMED: Array<{ file: string; keepsOwnRead?: true }> = [
    { file: "src/app/api/activity/route.ts" },
    { file: "src/lib/notifications/sendNotificationEmails.ts" },
    { file: "src/app/api/docs/[docId]/shareviews/route.ts" },
    { file: "src/app/api/uploads/[uploadId]/import-url/route.ts" },
    { file: "src/app/api/uploads/[uploadId]/process/route.ts", keepsOwnRead: true },
    { file: "src/lib/analytics/workspace/query.ts" },
    { file: "src/lib/people/profile.ts" },
  ];

  test.each(NAMED)("$file hydrates room names through projectNamesFor", ({ file, keepsOwnRead }) => {
    const src = source(file);
    expect(src, `${file} must import the name helper`).toMatch(/from\s*["']@\/lib\/projects\/names["']/);
    if (!keepsOwnRead) expect(src, `${file} must not keep a raw name read beside it`).not.toContain("ProjectModel");
  });

  it("the helper answers null rather than a name for a room the reader may not see", () => {
    const src = source("src/lib/projects/names.ts");
    expect(src).toContain("Promise<Map<string, string | null>>");
    expect(src).toContain("projectVisibilityClause(await projectGrantIds(orgKey, params.viewerUserId, params.request))");
    // Tenanted, which is the other half of decision 14: three of the reads it replaces had no orgId.
    expect(src).toContain("orgId: new Types.ObjectId(orgKey),");
  });
});

/**
 * The locked-id set is cached per workspace, so the write that changes it has to say so.
 *
 * The staleness runs the wrong way on a lock — ten seconds of a cached "nothing is hidden" is ten
 * seconds of a non-member still reading the room — so the invalidator is part of the write, not a
 * performance nicety.
 */
describe("locking a room clears the cached locked-id set", () => {
  const src = source("src/app/api/projects/[projectSlug]/route.ts");

  it("PATCH calls projectVisibilityChanged after it saves the row", () => {
    expect(src).toContain('projectVisibilityChanged({ orgId: actor.orgId })');
    expect(src.indexOf("await project.save()")).toBeLessThan(src.indexOf("projectVisibilityChanged({ orgId: actor.orgId })"));
  });

  it("DELETE clears it too, so a deleted room stops hiding its documents", () => {
    expect(src.match(/projectVisibilityChanged\(\{ orgId: actor\.orgId \}\)/g) ?? []).toHaveLength(2);
  });
});

/** Decision 27: a write into a room is filtered before it is role-checked. */
describe("writes into a locked room are refused as not found", () => {
  it("POST /api/docs resolves the home project through the clause and reuses PROJECT_NOT_FOUND", () => {
    const src = source("src/app/api/docs/route.ts");
    expect(src).toContain("$and: [projectVisibilityClause(await projectGrantIds(actor.orgId, actor.userId, request))]");
    expect(src).toContain('code: "PROJECT_NOT_FOUND"');
    expect(src).not.toContain("PROJECT_LOCKED");
  });

  it("PATCH /api/docs/:id filters the projects a document may join", () => {
    const src = source("src/app/api/docs/[docId]/route.ts");
    expect(src).toContain("$and: [projectVisibilityClause(await projectGrantIds(orgId, actor.userId, request))]");
  });

  it("the upload processor's auto-routing candidate set is the uploader's visible set", () => {
    const src = source("src/app/api/uploads/[uploadId]/process/route.ts");
    expect(src).toContain("$and: [projectVisibilityClause(await projectGrantIds(existingDocOrgId, actor.userId, request))]");
  });

  it("POST /api/uploads refuses a matching file onto a document in a room the uploader is outside", () => {
    const src = source("src/app/api/uploads/route.ts");
    expect(src).toContain("const postLockedExclusion = await lockedHomeExclusionFor(actor.orgId, actor.userId, request)");
    expect(src).toContain("postLockedExclusion,");
  });
});
