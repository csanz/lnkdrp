/**
 * Seed two private data rooms into the dev workspace, so locked projects can be *looked at*
 * (docs/prds/lnkdrp-locked-projects.md).
 *
 *   npx tsx --env-file=.env.local scripts/seed-locked-demo.ts
 *
 * It makes exactly two rooms and leaves every existing project alone, so the sidebar ends up showing
 * locked and unlocked rooms side by side, which is the comparison the lock icon exists to make:
 *
 * 1. **Project Atlas** — locked, the owner is in it, three real PDFs and one project share link. This
 *    is where the padlock shows up: the sidebar row, the project header, the project pill on each
 *    document, and every picker that names a project (`GET /api/projects?lite=1` carries
 *    `visibility` for exactly that reason).
 * 2. **Board comp review** — locked, the owner is **not** in it, created by a second workspace member
 *    (Dana Reyes) who is its only member, holding one document. This is the demonstration that
 *    matters, and the script prints the room's id and slug so it can be tried by hand: the owner of
 *    the workspace gets a 404 from `/project/<slug>` and from `/project/<id>`, byte-identical to a
 *    room that never existed. Not greyed out, not "no access" — absent. There is no owner or admin
 *    bypass anywhere in this feature (decision 21), which is the thing people do not believe until
 *    they watch their own workspace refuse them.
 *
 * **Everything goes through the app's own HTTP routes**, signed in as a real person with a real
 * NextAuth cookie, for the reason the PRD gives for putting the rule in a filter rather than in a
 * check: a seeder that writes rows by hand proves that Mongo accepts them and nothing else. Driving
 * `POST /api/projects { locked: true }`, `POST /api/docs`, `POST /api/uploads`, `.../import-url`,
 * `.../process` and `POST /api/projects/:slug/links` means the seed exercises the same gates the
 * browser does, so if this script succeeds the feature works, and if it 404s somewhere the feature is
 * broken in a way worth knowing about.
 *
 * The **one** direct model write is Dana: a `User` plus an active `OrgMembership`, because there is no
 * route that conjures a second workspace member without an email invitation somebody has to accept,
 * and a demo cannot wait on a mailbox. The address is on the reserved `.invalid` TLD so no mail can
 * ever leave for it.
 *
 * Idempotent by name. Rooms are looked up with `?q=`, documents by title inside their room, and the
 * project link by label; anything already there is reused rather than duplicated. A document that
 * exists but never reached `ready` is re-uploaded, which allocates a new version on that document —
 * noisy, and the honest repair for a half-finished seed.
 *
 * Needs the dev server running (`npm run dev`, port 3001) and a workspace with credits and plan room:
 * a Free workspace caps at two projects and three shared documents, and project share links are a Pro
 * gate, so on Free the link step reports a 402 and the rest of the seed still stands.
 */
import mongoose, { Types } from "mongoose";
import { encode } from "next-auth/jwt";

import { OrgModel } from "@/lib/models/Org";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { UserModel } from "@/lib/models/User";
import { connectMongo } from "@/lib/mongodb";
import { ACTIVE_ORG_COOKIE } from "@/lib/orgs/activeOrgCookie";
import { exit } from "./lib/exit";

/** The dev workspace this seed is for, and the person who owns it. */
const ORG_ID = "6ab46f3add6983534677931d";
const OWNER_USER_ID = "6ab46f3a542dc85d9d3ba00f";

/**
 * Where the running app is.
 *
 * `npm run dev` binds 3001 (see package.json), which is the default here for the same reason the
 * report prints full URLs: the point of this script is that somebody clicks the links it prints.
 */
const BASE = (process.env.LNKDRP_DEMO_BASE_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001").replace(/\/+$/, "");

/** The room the owner is in. */
const ATLAS = {
  name: "Project Atlas",
  description: "Series B data room — model, cap table and the diligence index. Members only.",
};
/** The room the owner is NOT in. */
const BOARD = {
  name: "Board comp review",
  description: "Compensation benchmarking for the December board meeting.",
};

/**
 * The second workspace member.
 *
 * `.invalid` is reserved by RFC 2606 and can never resolve, so the notification fanout this seed
 * triggers has nowhere to deliver even if a transport is configured.
 */
const DANA = {
  name: "Dana Reyes",
  email: "dana.reyes@lnkdrp.invalid",
  providerAccountId: "seed-locked-demo-dana-reyes",
};

/** Real PDFs, so the documents render a preview instead of a grey box. */
const ATLAS_DOCS: ReadonlyArray<{ title: string; url: string; fileName: string }> = [
  { title: "Atlas overview deck", url: "https://pdfobject.com/pdf/sample-3pp.pdf", fileName: "atlas-overview-deck.pdf" },
  { title: "Atlas cap table", url: "https://www.w3.org/WAI/WCAG21/working-examples/pdf-table/table.pdf", fileName: "atlas-cap-table.pdf" },
  { title: "Atlas diligence index", url: "https://www.w3.org/WAI/WCAG21/working-examples/pdf-links/links.pdf", fileName: "atlas-diligence-index.pdf" },
];
const BOARD_DOC = {
  title: "Board comp benchmark",
  url: "https://pdfobject.com/pdf/sample-3pp.pdf",
  fileName: "board-comp-benchmark.pdf",
};

const ATLAS_LINK_LABEL = "Series B investors";

/** How long to wait for one document to finish processing, and how often to ask. */
const READY_TIMEOUT_MS = 6 * 60_000;
const READY_POLL_MS = 3_000;

function say(line: string): void {
  // eslint-disable-next-line no-console
  console.log(line);
}

function fail(message: string): never {
  throw new Error(message);
}

/** One signed-in person, as a cookie header the routes can read. */
type Session = { label: string; userId: string; cookie: string };

/**
 * Mint a session for a local account.
 *
 * The same token `scripts/dev-session-token.ts` prints, plus the active-workspace cookie the app
 * issues on `/org/switch`. Both are sent because `resolveActiveOrgId` ranks cookie > stored metadata
 * > JWT claim, and a seed that only set the claim would be the weakest of the three — a script that
 * silently wrote into somebody's *personal* workspace is the exact failure that resolver's comment is
 * about.
 */
async function sessionFor(params: { label: string; userId: string; name: string; email: string }): Promise<Session> {
  const secret = (process.env.NEXTAUTH_SECRET ?? "").trim();
  if (!secret) fail("NEXTAUTH_SECRET is not set. Run with `--env-file=.env.local`.");
  const token = await encode({
    token: {
      name: params.name,
      email: params.email,
      sub: params.userId,
      userId: params.userId,
      role: "user",
      activeOrgId: ORG_ID,
    },
    secret,
    maxAge: 60 * 60,
  });
  // NextAuth's own rule for the cookie name: the `__Secure-` prefix only over https.
  const cookieName = BASE.startsWith("https://") ? "__Secure-next-auth.session-token" : "next-auth.session-token";
  return {
    label: params.label,
    userId: params.userId,
    cookie: `${cookieName}=${token}; ${ACTIVE_ORG_COOKIE}=${ORG_ID}`,
  };
}

type ApiResult<T> = { status: number; ok: boolean; body: T & { error?: string; message?: string; code?: string } };

/** One call to the app, with the session's cookies and no cache. */
async function call<T>(session: Session, method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        cookie: session.cookie,
        "cache-control": "no-cache",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (err) {
    fail(
      `${method} ${path} could not reach ${BASE} (${err instanceof Error ? err.message : String(err)}).\n` +
        "  Start the app first: npm run dev",
    );
  }
  const text = await res.text();
  let parsed: unknown = {};
  if (text.trim()) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { error: text.slice(0, 300) };
    }
  }
  return { status: res.status, ok: res.ok, body: parsed as ApiResult<T>["body"] };
}

/** The same call, refusing anything that is not a success — the seed has no useful partial states. */
async function api<T>(session: Session, method: string, path: string, body?: unknown): Promise<T> {
  const res = await call<T>(session, method, path, body);
  if (!res.ok) {
    const detail = res.body.error ?? res.body.message ?? "";
    const code = res.body.code ? ` [${res.body.code}]` : "";
    fail(`${method} ${path} answered ${res.status}${code}${detail ? `: ${detail}` : ""} (as ${session.label})`);
  }
  return res.body as T;
}

type ProjectRow = { id: string; name: string; slug: string; shareId: string | null; visibility: string; docCount: number };
type DocRow = { id: string; title: string; status: string; shareId: string | null; currentUploadId: string | null };

/** Find one live project by name, as this person can see it — a locked room they are not in is absent. */
async function findProject(session: Session, name: string): Promise<ProjectRow | null> {
  const out = await api<{ projects: ProjectRow[] }>(session, "GET", `/api/projects?limit=100&q=${encodeURIComponent(name)}`);
  return out.projects.find((p) => (p.name ?? "").trim().toLowerCase() === name.toLowerCase()) ?? null;
}

/**
 * The room, created locked if it is not there yet.
 *
 * `POST /api/projects { locked: true }` is the create half of decision 31: it writes `visibility`,
 * `lockedAt` and `lockedByUserId` and seats the creator as the room's first member in one step. It
 * has to seat them — with no grant the room is invisible to the person who just made it, because
 * there is no owner bypass to fall back on.
 *
 * A same-named project that exists and is *not* locked is left alone and reported. Locking an
 * existing room is `PATCH { visibility }` behind the lock-review token, which is a decision about
 * documents and recipients that a seed script has no business making on somebody's behalf.
 */
async function ensureRoom(session: Session, spec: { name: string; description: string }): Promise<{ project: ProjectRow; created: boolean }> {
  const existing = await findProject(session, spec.name);
  if (existing) {
    if (existing.visibility !== "locked") {
      fail(
        `"${spec.name}" already exists in this workspace and is NOT locked (${BASE}/project/${existing.slug}).\n` +
          "  Rename or delete it, or lock it from the project page, then run this again.",
      );
    }
    return { project: existing, created: false };
  }
  const out = await api<{ project: ProjectRow }>(session, "POST", "/api/projects", {
    name: spec.name,
    description: spec.description,
    locked: true,
  });
  return { project: out.project, created: true };
}

/** The documents in one room, as this person sees them. */
async function roomDocs(session: Session, slug: string): Promise<DocRow[]> {
  const out = await api<{ docs: DocRow[] }>(session, "GET", `/api/projects/${encodeURIComponent(slug)}/docs?limit=100`);
  return out.docs;
}

/**
 * Wait for one document to finish processing.
 *
 * The upload pipeline extracts text, rasterizes a preview and runs the AI passes, and the route that
 * starts it can return before that work is done, so "ready" is a state to be watched rather than a
 * response to be read. `failed` is terminal and carries the reason on the upload row.
 */
async function waitUntilReady(session: Session, doc: { id: string; title: string }): Promise<void> {
  const started = Date.now();
  let lastStatus = "";
  for (;;) {
    const out = await api<{ doc: { status?: string | null } }>(session, "GET", `/api/docs/${doc.id}?lite=1`);
    const status = (out.doc?.status ?? "").trim() || "unknown";
    if (status !== lastStatus) {
      say(`      ${doc.title}: ${status}`);
      lastStatus = status;
    }
    if (status === "ready") return;
    if (status === "failed") fail(`"${doc.title}" finished as failed. Open ${BASE}/doc/${doc.id} for the reason.`);
    if (Date.now() - started > READY_TIMEOUT_MS) {
      fail(`"${doc.title}" was still "${status}" after ${Math.round(READY_TIMEOUT_MS / 1000)}s. Left as is: ${BASE}/doc/${doc.id}`);
    }
    await new Promise((r) => setTimeout(r, READY_POLL_MS));
  }
}

/**
 * One document in one room, from a real PDF, waited through to `ready`.
 *
 * `projectId` on the create is the project-home rule: the document is born inside the room, so every
 * consumer that runs during processing already sees it there, and there is no window in which it sits
 * in the workspace list first. `visibility` is left at `"workspace"` deliberately — the document is
 * still listed workspace-wide *for the people who can see its room*, which is what puts the padlocked
 * project pill on the document cards in the main list where it can be seen.
 */
async function ensureRoomDoc(
  session: Session,
  project: ProjectRow,
  spec: { title: string; url: string; fileName: string },
): Promise<{ doc: DocRow; created: boolean }> {
  const before = await roomDocs(session, project.slug);
  const existing = before.find((d) => (d.title ?? "").trim().toLowerCase() === spec.title.toLowerCase());
  if (existing && existing.status === "ready") return { doc: existing, created: false };

  let docId = existing?.id ?? "";
  if (!docId) {
    const created = await api<{ doc: { id: string; shareId: string | null } }>(session, "POST", "/api/docs", {
      title: spec.title,
      projectId: project.id,
    });
    docId = created.doc.id;
    say(`      created ${spec.title} (${docId})`);
  } else {
    say(`      ${spec.title} exists but is "${existing?.status}" — re-uploading it as a new version`);
  }

  const upload = await api<{ upload: { id: string } }>(session, "POST", "/api/uploads", {
    docId,
    originalFileName: spec.fileName,
    contentType: "application/pdf",
  });
  await api(session, "POST", `/api/uploads/${upload.upload.id}/import-url`, { url: spec.url });

  /**
   * Processing can outlive the HTTP response (the route hands the tail of the work to `after()`), and
   * a socket that times out on a slow 300-second run says nothing about whether the run succeeded. So
   * a transport failure here is reported and then *polled through*, and only the document's own
   * status decides.
   */
  const processed = await call(session, "POST", `/api/uploads/${upload.upload.id}/process`).catch((err: unknown) => {
    say(`      process call did not return cleanly (${err instanceof Error ? err.message : String(err)}); polling the document instead`);
    return null;
  });
  if (processed && !processed.ok) {
    const detail = processed.body.error ?? processed.body.message ?? "";
    const code = processed.body.code ? ` [${processed.body.code}]` : "";
    fail(`processing "${spec.title}" answered ${processed.status}${code}${detail ? `: ${detail}` : ""}`);
  }

  await waitUntilReady(session, { id: docId, title: spec.title });
  const after = await roomDocs(session, project.slug);
  const doc = after.find((d) => d.id === docId);
  if (!doc) fail(`"${spec.title}" is ready but no longer listed in ${project.name}. That is a bug worth chasing.`);
  return { doc, created: true };
}

/**
 * One share link on the room, so the recipient half of the feature is on screen too.
 *
 * A link already sent keeps working whether the room is locked or not (decision 26) — a recipient is
 * not a member and never was. Creating one is Pro (`project_links`), so a 402 here is reported and
 * skipped: the room's default `/p/:shareId` still exists and still resolves.
 */
async function ensureRoomLink(session: Session, project: ProjectRow): Promise<{ shareId: string | null; note: string | null }> {
  const listed = await api<{ links: Array<{ id: string; shareId: string; label: string; isDefault: boolean }> }>(
    session,
    "GET",
    `/api/projects/${encodeURIComponent(project.slug)}/links?limit=100`,
  );
  const existing = listed.links.find((l) => (l.label ?? "").trim().toLowerCase() === ATLAS_LINK_LABEL.toLowerCase());
  if (existing) return { shareId: existing.shareId, note: null };

  const res = await call<{ link: { shareId: string } }>(session, "POST", `/api/projects/${encodeURIComponent(project.slug)}/links`, {
    label: ATLAS_LINK_LABEL,
    audience: "Series B",
    enabled: true,
  });
  if (!res.ok) {
    const detail = res.body.error ?? res.body.message ?? "";
    const note = `no extra share link (${res.status}${res.body.code ? ` ${res.body.code}` : ""}${detail ? `: ${detail}` : ""})`;
    const fallback = listed.links.find((l) => l.isDefault) ?? listed.links[0] ?? null;
    return { shareId: fallback?.shareId ?? project.shareId, note };
  }
  return { shareId: res.body.link.shareId, note: null };
}

/**
 * The second workspace member, written directly — the one place this script skips a route.
 *
 * There is no endpoint that puts somebody in a workspace without an invitation they accept from their
 * own inbox, and the whole point of this room is that it belongs to a person who is not the owner. So
 * the `User` and the `OrgMembership` are written here, with the same fields the invite-claim path
 * writes, and every locked-project act after this one goes through the API as Dana.
 *
 * Re-runnable: the row is looked up by email, and a membership that was revoked is revived rather
 * than inserted beside (the `{ orgId, userId }` index is unique).
 */
async function ensureSecondMember(): Promise<{ userId: string; created: boolean }> {
  const existing = (await UserModel.findOne({ email: DANA.email }).select({ _id: 1, isActive: 1, deletionRequestedAt: 1 }).lean()) as
    | { _id: Types.ObjectId; isActive?: unknown; deletionRequestedAt?: unknown }
    | null;

  let userId: string;
  let created = false;
  if (existing) {
    if (existing.isActive === false || existing.deletionRequestedAt) {
      // A disabled account has its session ended by `resolveActor` on every request, so it could not
      // create the room below; put the demo account back rather than fail halfway through.
      await UserModel.updateOne({ _id: existing._id }, { $set: { isActive: true, deletionRequestedAt: null, deletionPurgeAfter: null } });
    }
    userId = String(existing._id);
  } else {
    const made = await UserModel.create({
      email: DANA.email,
      name: DANA.name,
      authProvider: "google",
      providerAccountId: DANA.providerAccountId,
      isActive: true,
      accessStatus: "approved",
    });
    userId = String((made as unknown as { _id: Types.ObjectId })._id);
    created = true;
  }

  // The workspace this account acts in when it has no cookie yet. The seed sends the cookie anyway;
  // this is so the row reads the way a real member's does.
  await UserModel.updateOne({ _id: new Types.ObjectId(userId) }, { $set: { "metadata.activeOrgId": ORG_ID } });

  await OrgMembershipModel.updateOne(
    { orgId: new Types.ObjectId(ORG_ID), userId: new Types.ObjectId(userId) },
    { $set: { role: "member", isDeleted: false } },
    { upsert: true },
  );

  return { userId, created };
}

async function main(): Promise<void> {
  if (!Types.ObjectId.isValid(ORG_ID) || !Types.ObjectId.isValid(OWNER_USER_ID)) fail("ORG_ID / OWNER_USER_ID are not object ids.");
  await connectMongo();

  const org = (await OrgModel.findById(new Types.ObjectId(ORG_ID)).select({ name: 1, isDeleted: 1 }).lean()) as
    | { name?: string; isDeleted?: unknown }
    | null;
  if (!org || org.isDeleted === true) fail(`No live workspace ${ORG_ID} in this database. Check MONGODB_URI in .env.local.`);

  const owner = (await UserModel.findById(new Types.ObjectId(OWNER_USER_ID)).select({ name: 1, email: 1 }).lean()) as
    | { name?: string; email?: string }
    | null;
  if (!owner?.email) fail(`No account ${OWNER_USER_ID} in this database.`);
  const ownerMembership = await OrgMembershipModel.exists({
    orgId: new Types.ObjectId(ORG_ID),
    userId: new Types.ObjectId(OWNER_USER_ID),
    isDeleted: { $ne: true },
  });
  if (!ownerMembership) fail(`${owner.email} is not a live member of workspace ${ORG_ID}.`);

  say("");
  say(`  workspace  ${org.name ?? "(unnamed)"}  (${ORG_ID})`);
  say(`  owner      ${owner.email}  (${OWNER_USER_ID})`);
  say(`  app        ${BASE}`);

  const ownerSession = await sessionFor({
    label: "owner",
    userId: OWNER_USER_ID,
    name: owner.name ?? "",
    email: owner.email,
  });

  // Fails fast and clearly if the app is not up, before anything is written.
  await api(ownerSession, "GET", "/api/projects?limit=1&lite=1");

  say("");
  say("▸ 1/4  the second workspace member (the one direct model write)");
  const dana = await ensureSecondMember();
  say(`      ${DANA.name} <${DANA.email}> ${dana.created ? "created" : "reused"} (${dana.userId}), role member`);
  const danaSession = await sessionFor({ label: DANA.name, userId: dana.userId, name: DANA.name, email: DANA.email });

  say("");
  say(`▸ 2/4  "${ATLAS.name}" — locked, the owner is in it`);
  const atlas = await ensureRoom(ownerSession, ATLAS);
  say(`      ${atlas.created ? "created" : "reused"} ${atlas.project.id}  /project/${atlas.project.slug}`);
  const atlasDocs: DocRow[] = [];
  for (const spec of ATLAS_DOCS) {
    const { doc, created } = await ensureRoomDoc(ownerSession, atlas.project, spec);
    atlasDocs.push(doc);
    say(`      ${created ? "seeded" : "reused"} ${doc.title} (${doc.id})`);
  }
  const link = await ensureRoomLink(ownerSession, atlas.project);
  say(`      share link ${link.note ? link.note : `/p/${link.shareId}`}`);

  say("");
  say(`▸ 3/4  "${BOARD.name}" — locked, the owner is NOT in it`);
  const board = await ensureRoom(danaSession, BOARD);
  say(`      ${board.created ? "created" : "reused"} ${board.project.id}  /project/${board.project.slug}  (member: ${DANA.name} only)`);
  const boardDoc = await ensureRoomDoc(danaSession, board.project, BOARD_DOC);
  say(`      ${boardDoc.created ? "seeded" : "reused"} ${boardDoc.doc.title} (${boardDoc.doc.id})`);

  say("");
  say("▸ 4/4  what the owner can see");
  const ownerSeesBoard = await findProject(ownerSession, BOARD.name);
  const ownerById = await call(ownerSession, "GET", `/api/projects/${board.project.id}`);
  const ownerBySlug = await call(ownerSession, "GET", `/api/projects/${encodeURIComponent(board.project.slug)}`);
  say(`      "${BOARD.name}" in the owner's project list: ${ownerSeesBoard ? "PRESENT — that is a leak" : "absent"}`);
  say(`      owner GET /api/projects/${board.project.id} → ${ownerById.status}${ownerById.status === 404 ? "" : "  ← expected 404"}`);
  say(`      owner GET /api/projects/${board.project.slug} → ${ownerBySlug.status}${ownerBySlug.status === 404 ? "" : "  ← expected 404"}`);

  const roster = await api<{ members: Array<{ name?: string | null; email?: string | null; role: string }>; candidates: unknown[] }>(
    ownerSession,
    "GET",
    `/api/projects/${encodeURIComponent(atlas.project.slug)}/members`,
  );
  say(`      "${ATLAS.name}" roster: ${roster.members.map((m) => `${m.email ?? m.name ?? "?"} (${m.role})`).join(", ") || "(empty)"}`);

  say("");
  say("  ──────────────────────────────────────────────────────────────");
  say("  Look at these, in this order:");
  say("");
  say(`   1. ${BASE}/`);
  say(`      The sidebar. "${ATLAS.name}" carries a padlock; the unlocked rooms beside it do not.`);
  say(`      "${BOARD.name}" is not in the list at all — it is not greyed out, it is absent.`);
  say("");
  say(`   2. ${BASE}/project/${atlas.project.slug}`);
  say("      The room. Padlock in the header, the members panel, and the three documents in it.");
  say("");
  for (const [i, doc] of atlasDocs.entries()) {
    say(`   ${3 + i}. ${BASE}/doc/${doc.id}`);
    say(`      ${doc.title} — the project pill under the title carries the padlock.`);
    say("");
  }
  const n = 3 + atlasDocs.length;
  say(`   ${n}. ${BASE}/p/${link.shareId ?? atlas.project.shareId ?? "(no share id)"}`);
  say("      The recipient's view of a locked room. A link already sent keeps working (decision 26).");
  say("");
  say(`   ${n + 1}. ${BASE}/project/${board.project.slug}      → 404`);
  say(`       ${BASE}/project/${board.project.id}   → 404`);
  say(`       "${BOARD.name}": id ${board.project.id}, slug ${board.project.slug}.`);
  say("       Signed in as the workspace OWNER, both answer 404, identical to a room that never");
  say("       existed. No bypass for owners or admins — this is the decision the feature turns on.");
  say("");
  say(`   ${n + 2}. ${BASE}/activity`);
  say(`       The feed. "locked" and "added to" rows for "${ATLAS.name}" are here; nothing about`);
  say(`       "${BOARD.name}" is, because rows inside a room are only for the people in it.`);
  say("");
  say(`   ${n + 3}. ${BASE}/doc/${atlasDocs[0]?.id ?? ""} → Add to a project`);
  say("       The picker names the locked room with its padlock, so filing something into it is a");
  say("       deliberate act rather than a guess.");
  say("");
  say(`  To watch it from the other side, mint a session for ${DANA.email}:`);
  say(`    npx tsx --env-file=.env.local scripts/dev-session-token.ts ${DANA.email}`);
  say("  and paste it into a private window as the next-auth.session-token cookie. That person sees");
  say(`  "${BOARD.name}" and not "${ATLAS.name}" — the mirror image of the owner's sidebar.`);
  say("");
}

main()
  .then(async () => {
    await mongoose.disconnect().catch(() => undefined);
    return exit(0);
  })
  .catch(async (e) => {
    console.error("\n  Failed:", e instanceof Error ? e.message : e, "\n");
    await mongoose.disconnect().catch(() => undefined);
    return exit(1);
  });
