/**
 * The purge destroys its own index last.
 *
 * `planPurge` learns which workspaces to empty from one query, `OrgMembershipModel.find({ userId })`,
 * and every deletion in `purgeAccount` is gated on the `soloOrgIds` it returns. So the membership
 * and org rows are not ordinary rows: they are the only thing that still links an account to the
 * twenty-odd collections being swept. While they sat inside the same unordered `Promise.all` as
 * `ShareViewModel.deleteMany` and friends, one sibling rejecting was enough to commit them while
 * the rest of the sweep was still in flight. `deletionPurgedAt` is stamped only after that block
 * (purge.ts, and again in src/app/api/cron/account-purge/route.ts), so the account came back as
 * due, the retry found no memberships, resolved `soloOrgIds` to `[]`, skipped every gated block and
 * returned `abortedReason: null` — the route stamped it done, the summary said `purged: 1` and the
 * health row said `ok` while every unreached row was unreachable by any query for ever.
 *
 * Same principle purgeCompleteness.test.ts pins one block earlier for `docIds`/`projectIds`, held
 * across a crash boundary rather than within a single batch. The models are mocked in the style of
 * tests/lib/docMetricsScope.test.ts: the assertion is about the order the deletes are *issued*,
 * which is exactly where the rule lives.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const USER_ID = new Types.ObjectId();
const ORG_ID = new Types.ObjectId();
const DOC_ID = new Types.ObjectId();

/** Every `deleteMany` this run issued, in the order it was issued. */
const deleteCalls: string[] = [];
/** Which collection's `deleteMany` should reject, standing in for a killed or failed sweep. */
const failing = { name: null as string | null };

function chain(rows: unknown[]) {
  const c: any = {
    select: () => c,
    limit: () => c,
    sort: () => c,
    lean: async () => rows,
  };
  return c;
}

function stub(name: string, rows: unknown[] = []) {
  return {
    find: () => chain(rows),
    findOne: () => chain(rows),
    countDocuments: async () => 0,
    updateOne: async () => ({ acknowledged: true }),
    deleteMany: async () => {
      deleteCalls.push(name);
      if (failing.name === name) throw new Error(`${name}.deleteMany failed`);
      return { deletedCount: 0 };
    },
  };
}

vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));
vi.mock("@vercel/blob", () => ({ del: vi.fn(async () => undefined) }));

vi.mock("@/lib/models/User", () => ({
  UserModel: {
    findOne: () => ({
      select: () => ({ lean: async () => ({ email: "gone@example.com", deletionRequestedAt: new Date(), deletionPurgeAfter: new Date() }) }),
    }),
    updateOne: async () => ({ acknowledged: true }),
  },
}));

vi.mock("@/lib/models/OrgMembership", () => ({
  OrgMembershipModel: {
    // One workspace, and nobody else in it: the solo case the purge is written for.
    find: () => ({ select: () => ({ limit: () => ({ lean: async () => [{ orgId: ORG_ID, role: "owner" }] }) }) }),
    countDocuments: async () => 0,
    deleteMany: async () => {
      deleteCalls.push("OrgMembership");
      if (failing.name === "OrgMembership") throw new Error("OrgMembership.deleteMany failed");
      return { deletedCount: 0 };
    },
  },
}));

vi.mock("@/lib/models/Org", () => ({ OrgModel: stub("Org") }));
vi.mock("@/lib/models/Doc", () => ({ DocModel: stub("Doc", [{ _id: DOC_ID }]) }));
vi.mock("@/lib/models/Upload", () => ({ UploadModel: stub("Upload") }));
vi.mock("@/lib/models/Subscription", () => ({ SubscriptionModel: stub("Subscription") }));
vi.mock("@/lib/models/Project", () => ({ ProjectModel: stub("Project") }));
vi.mock("@/lib/models/ShareLink", () => ({ ShareLinkModel: stub("ShareLink") }));
vi.mock("@/lib/models/ShareView", () => ({ ShareViewModel: stub("ShareView") }));
vi.mock("@/lib/models/ShareVisit", () => ({ ShareVisitModel: stub("ShareVisit") }));
vi.mock("@/lib/models/VisitBrief", () => ({ VisitBriefModel: stub("VisitBrief") }));
vi.mock("@/lib/models/ActivityEvent", () => ({ ActivityEventModel: stub("ActivityEvent") }));
// The real module too: OAuthGrant and OAuthCode import API_KEY_SCOPES from it (a schema enum, no DB).
vi.mock("@/lib/models/ApiKey", async (importOriginal) => ({ ...(await importOriginal<object>()), ApiKeyModel: stub("ApiKey") }));
vi.mock("@/lib/models/SlackConnection", () => ({ SlackConnectionModel: stub("SlackConnection") }));
// Added to the purge with the OAuth sign-in work; unmocked they buffered against no database and timed out.
vi.mock("@/lib/models/OAuthGrant", () => ({ OAuthGrantModel: stub("OAuthGrant") }));
vi.mock("@/lib/models/OAuthCode", () => ({ OAuthCodeModel: stub("OAuthCode") }));
vi.mock("@/lib/models/CreditLedger", () => ({ CreditLedgerModel: stub("CreditLedger") }));
vi.mock("@/lib/models/WorkspaceCreditBalance", () => ({ WorkspaceCreditBalanceModel: stub("WorkspaceCreditBalance") }));
vi.mock("@/lib/models/CreditPurchase", () => ({ CreditPurchaseModel: stub("CreditPurchase") }));
vi.mock("@/lib/models/DocChange", () => ({ DocChangeModel: stub("DocChange") }));
vi.mock("@/lib/models/DocPageTiming", () => ({ DocPageTimingModel: stub("DocPageTiming") }));
vi.mock("@/lib/models/ErrorEvent", () => ({ ErrorEventModel: stub("ErrorEvent") }));
vi.mock("@/lib/models/NotificationEmailCursor", () => ({ NotificationEmailCursorModel: stub("NotificationEmailCursor") }));
vi.mock("@/lib/models/NotificationQueue", () => ({ NotificationQueueModel: stub("NotificationQueue") }));
vi.mock("@/lib/models/OrgInvite", () => ({ OrgInviteModel: stub("OrgInvite") }));
vi.mock("@/lib/models/AiRun", () => ({ AiRunModel: stub("AiRun") }));
vi.mock("@/lib/models/Review", () => ({ ReviewModel: stub("Review") }));
vi.mock("@/lib/models/DocReport", () => ({ DocReportModel: stub("DocReport") }));
vi.mock("@/lib/models/ProjectClick", () => ({ ProjectClickModel: stub("ProjectClick") }));
vi.mock("@/lib/models/ProjectView", () => ({ ProjectViewModel: stub("ProjectView") }));
vi.mock("@/lib/models/ShareDownloadRequest", () => ({ ShareDownloadRequestModel: stub("ShareDownloadRequest") }));
vi.mock("@/lib/models/ProjectLinkView", () => ({ ProjectLinkViewModel: stub("ProjectLinkView") }));
vi.mock("@/lib/models/ShareViewerEmail", () => ({ ShareViewerEmailModel: stub("ShareViewerEmail") }));
vi.mock("@/lib/models/StarredDoc", () => ({ StarredDocModel: stub("StarredDoc") }));
vi.mock("@/lib/models/Tag", () => ({ TagModel: stub("Tag") }));
vi.mock("@/lib/models/TagAssignment", () => ({ TagAssignmentModel: stub("TagAssignment") }));
vi.mock("@/lib/models/UsageAggCycle", () => ({ UsageAggCycleModel: stub("UsageAggCycle") }));
vi.mock("@/lib/models/UsageAggDaily", () => ({ UsageAggDailyModel: stub("UsageAggDaily") }));

const { purgeAccount } = await import("@/lib/accounts/purge");

const INDEX_ROWS = new Set(["Org", "OrgMembership"]);

beforeEach(() => {
  deleteCalls.length = 0;
  failing.name = null;
});

describe("the rows the purge derives itself from are deleted last", () => {
  test("a clean run empties every collection before dropping the memberships and the org", async () => {
    const res = await purgeAccount(String(USER_ID));

    expect(res?.abortedReason).toBeNull();
    expect(deleteCalls).toContain("Org");
    expect(deleteCalls).toContain("ShareView");

    const firstIndexRow = deleteCalls.findIndex((n) => INDEX_ROWS.has(n));
    const lastOther = deleteCalls.reduce((last, n, i) => (INDEX_ROWS.has(n) ? last : i), -1);
    // Nothing else may still be pending when the only pointer back to this account disappears.
    expect(firstIndexRow).toBeGreaterThan(lastOther);
  });

  test("a sweep that fails part way leaves the memberships and the org alone", async () => {
    // One large analytics deleteMany rejects, which is what a killed run looks like from here:
    // the siblings dispatched alongside it have already committed.
    failing.name = "ShareView";

    await expect(purgeAccount(String(USER_ID))).rejects.toThrow(/ShareView/);

    // If these had gone with the batch, the retry would find no memberships, resolve soloOrgIds to
    // [] and report the account purged with everything the batch never reached left behind.
    expect(deleteCalls).not.toContain("Org");
    expect(deleteCalls).not.toContain("OrgMembership");
  });
});
