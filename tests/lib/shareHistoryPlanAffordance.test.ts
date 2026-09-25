/**
 * The History control on `/s/:shareId` and the plan that decides whether it can ever work.
 *
 * `allowRevisionHistory` is a per-link toggle, but version history is also a Pro feature, and the
 * toggle is only gated when it is *set*. A workspace that turned it on while on Pro and then
 * downgraded keeps `allowRevisionHistory: true` on every link it ever made: nothing clears it, and
 * the write-time gate only fires on the false -> true transition. So the two routes that serve the
 * history re-ask the plan on every read (`ownerCanShowVersionHistory`, see `src/lib/share/
 * ownerPlan.ts`) — and the page that *draws the control* did not, which is what these tests pin.
 *
 * The shape that broke: the page said `revisionHistoryEnabled: true`, the viewer drew History and
 * armed its idle prefetch, and every request came back `403 {"error":"Version history disabled"}`
 * — rendered verbatim to the recipient, permanently, with nothing telling the owner about it.
 *
 * `checkLimit` is mocked rather than `ownerCanShowVersionHistory`, so the real helper runs and the
 * assertion is about the plan question the route asks, not about a function name.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const { resolveShareLink, checkLimit, ensurePersonalOrgForUserId, workspaceBrandForOrg, cookies } = vi.hoisted(() => ({
  resolveShareLink: vi.fn(),
  checkLimit: vi.fn(),
  ensurePersonalOrgForUserId: vi.fn(),
  workspaceBrandForOrg: vi.fn(),
  cookies: vi.fn(),
}));

vi.mock("@/lib/share/links", () => ({ resolveShareLink, resolveShareLinkForPage: resolveShareLink }));
vi.mock("@/lib/billing/planLimits", () => ({ checkLimit }));
vi.mock("@/lib/models/Org", () => ({ ensurePersonalOrgForUserId }));
vi.mock("@/lib/share/shareBrand", () => ({ workspaceBrandForOrg }));
vi.mock("@/lib/share/shareMetadata", () => ({ buildShareMetadata: () => ({}) }));
vi.mock("next/headers", () => ({ cookies }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
// The recipient-facing viewer and its chrome: only the props the page hands them matter here.
vi.mock("@/app/s/[shareId]/ShareViewerClient", () => ({ default: function ShareViewerClient() { return null; } }));
vi.mock("@/app/s/[shareId]/PasswordGate", () => ({ default: function PasswordGate() { return null; } }));
vi.mock("@/components/BrandHeader", () => ({ default: function BrandHeader() { return null; } }));

const { default: SharePage } = await import("@/app/s/[shareId]/page");

const SHARE_ID = "srPlAnGaTe01";
const ORG_ID = new Types.ObjectId();

/** What `resolveShareLink` hands the page for a live link on a document that has a PDF. */
function resolved(opts: { allowRevisionHistory: boolean; orgId?: Types.ObjectId | null; userId?: Types.ObjectId | null }) {
  return {
    link: {
      shareId: SHARE_ID,
      allowDownload: false,
      allowRevisionHistory: opts.allowRevisionHistory,
      passwordHash: null,
      passwordSalt: null,
    },
    doc: {
      _id: new Types.ObjectId(),
      orgId: opts.orgId === undefined ? ORG_ID : opts.orgId,
      userId: opts.userId ?? null,
      title: "Northwind Series A",
      blobUrl: "https://blob.example/deck.pdf",
    },
    refusal: null,
  };
}

/** The props the page gives the viewer, which is where the History control comes from. */
async function viewerProps(): Promise<Record<string, unknown>> {
  const page = (await SharePage({ params: Promise.resolve({ shareId: SHARE_ID }) })) as {
    props: { children: { props: Record<string, unknown> } };
  };
  return page.props.children.props;
}

beforeEach(() => {
  vi.clearAllMocks();
  workspaceBrandForOrg.mockResolvedValue(null);
  cookies.mockResolvedValue({ get: () => undefined });
});

describe("/s/:shareId only offers History when the owner's plan can serve it", () => {
  test("Pro: the toggle is honoured and the control gets its URL", async () => {
    resolveShareLink.mockResolvedValue(resolved({ allowRevisionHistory: true }));
    checkLimit.mockResolvedValue({ ok: true, warning: null });

    const props = await viewerProps();
    expect(props.revisionHistoryEnabled).toBe(true);
    expect(props.revisionHistoryUrl).toBe(`/s/${SHARE_ID}/changes`);
    // The same question the read path asks, about the same workspace.
    expect(checkLimit).toHaveBeenCalledWith(expect.anything(), "version_history");
    expect(String((checkLimit.mock.calls[0] as unknown[])[0])).toBe(String(ORG_ID));
  });

  test("downgraded to Free: no control, rather than one that 403s on every press", async () => {
    resolveShareLink.mockResolvedValue(resolved({ allowRevisionHistory: true }));
    checkLimit.mockResolvedValue({ ok: false, code: "plan_limit", limit: "version_history", used: 0, requested: 0, max: 0, grace: null });

    const props = await viewerProps();
    expect(props.revisionHistoryEnabled).toBe(false);
    expect(props.revisionHistoryUrl).toBe(null);
  });

  test("a plan lookup that throws withholds the control, like the route withholds the data", async () => {
    resolveShareLink.mockResolvedValue(resolved({ allowRevisionHistory: true }));
    checkLimit.mockRejectedValue(new Error("billing lookup failed"));

    const props = await viewerProps();
    expect(props.revisionHistoryEnabled).toBe(false);
    expect(props.revisionHistoryUrl).toBe(null);
  });

  test("a legacy pre-workspace doc resolves its owner's personal workspace instead of failing shut", async () => {
    const userId = new Types.ObjectId();
    resolveShareLink.mockResolvedValue(resolved({ allowRevisionHistory: true, orgId: null, userId }));
    ensurePersonalOrgForUserId.mockResolvedValue({ orgId: ORG_ID });
    checkLimit.mockResolvedValue({ ok: true, warning: null });

    const props = await viewerProps();
    expect(props.revisionHistoryEnabled).toBe(true);
  });

  test("the toggle off costs no plan lookup", async () => {
    resolveShareLink.mockResolvedValue(resolved({ allowRevisionHistory: false }));

    const props = await viewerProps();
    expect(props.revisionHistoryEnabled).toBe(false);
    expect(props.revisionHistoryUrl).toBe(null);
    expect(checkLimit).not.toHaveBeenCalled();
  });
});
