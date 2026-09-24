/**
 * "Can the user in `MONGODB_URI` actually use the database that URI names?"
 *
 * Atlas grants roles per database *name*, and a name is an exact string: `lnkdrp_dev` and
 * `lnkdrp-dev` are two databases, and a user with `readWrite` on one has nothing on the other.
 * When the URI's path and the role's database drift apart the driver connects fine (authentication
 * is cluster-wide) and every command after that fails with code 13, which the app then surfaces as
 * a wall of `not authorized on <db> to execute command { find: "users", filter: { ... } }` — once per
 * request, once per change stream, and once in the browser's address bar after a sign-in attempt.
 * Nothing in that text says "the database name is wrong".
 *
 * This module turns that into one sentence. It is import-free on purpose: the realtime image copies
 * it (`realtime/Dockerfile`), and anything it pulled in would have to be copied too.
 */

/** One entry of `connectionStatus.authInfo.authenticatedUserPrivileges`. */
export type MongoPrivilege = {
  resource: { db?: string; collection?: string; cluster?: boolean; anyResource?: boolean };
  actions: string[];
};

/** The part of `connectionStatus` this module reads. Every field is optional: shapes vary by server. */
export type MongoAuthInfo = {
  authenticatedUsers?: Array<{ user?: string; db?: string }>;
  authenticatedUserRoles?: Array<{ role?: string; db?: string }>;
  authenticatedUserPrivileges?: MongoPrivilege[];
};

export type MongoAccessVerdict =
  | { ok: true; database: string; user: string | null }
  | { ok: false; database: string; user: string | null; grantedOn: string[]; message: string };

/**
 * The database a Mongo connection string names, or "" when it names none.
 *
 * String surgery rather than `new URL()`: a replica-set URI lists hosts with commas, which is not a
 * valid URL host, and the path is the only part wanted here.
 */
export function mongoUriDatabase(uri: string): string {
  const raw = String(uri ?? "").trim();
  const schemeEnd = raw.indexOf("://");
  if (schemeEnd === -1) return "";
  const afterScheme = raw.slice(schemeEnd + 3);
  const at = afterScheme.lastIndexOf("@");
  const hostAndPath = at === -1 ? afterScheme : afterScheme.slice(at + 1);
  const slash = hostAndPath.indexOf("/");
  if (slash === -1) return "";
  const q = hostAndPath.indexOf("?", slash);
  const path = hostAndPath.slice(slash + 1, q === -1 ? undefined : q);
  try {
    return decodeURIComponent(path).trim();
  } catch {
    return path.trim();
  }
}

/**
 * The user in a connection string, for messages. Never the password.
 */
export function mongoUriUser(uri: string): string | null {
  const raw = String(uri ?? "").trim();
  const schemeEnd = raw.indexOf("://");
  if (schemeEnd === -1) return null;
  const afterScheme = raw.slice(schemeEnd + 3);
  const at = afterScheme.lastIndexOf("@");
  if (at === -1) return null;
  const cred = afterScheme.slice(0, at);
  const colon = cred.indexOf(":");
  const user = colon === -1 ? cred : cred.slice(0, colon);
  try {
    return decodeURIComponent(user) || null;
  } catch {
    return user || null;
  }
}

/** Mongo answers code 13 / `Unauthorized` when the user is authenticated but has no right to the command. */
export function isMongoAuthzError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; codeName?: unknown; message?: unknown };
  if (e.code === 13 || e.codeName === "Unauthorized") return true;
  return typeof e.message === "string" && /^not authorized on \S+ to execute command/.test(e.message);
}

/**
 * Judge the privileges `connectionStatus` reports against the database the process wants.
 *
 * "Covers" means any privilege whose resource is that database, every database (`db: ""`), the
 * whole cluster, or `anyResource`. An empty privilege list is treated as unknown, not as denied:
 * the point is to explain the one mistake this catches, not to second-guess a server that reports
 * its grants in a shape this code has not seen.
 */
export function judgeMongoAccess(database: string, authInfo: MongoAuthInfo | null | undefined): MongoAccessVerdict {
  const user = authInfo?.authenticatedUsers?.[0]?.user ?? null;
  const privileges = authInfo?.authenticatedUserPrivileges ?? [];
  if (!database || privileges.length === 0) return { ok: true, database, user };

  const covers = privileges.some((p) => {
    const r = p?.resource ?? {};
    if (r.anyResource || r.cluster) return true;
    if (typeof r.db !== "string") return false;
    return r.db === "" || r.db === database;
  });
  if (covers) return { ok: true, database, user };

  const grantedOn = [
    ...new Set(privileges.map((p) => p?.resource?.db).filter((d): d is string => typeof d === "string" && d !== "")),
  ];
  const roles = (authInfo?.authenticatedUserRoles ?? [])
    .map((r) => (r.role && r.db ? `${r.role}@${r.db}` : null))
    .filter((s): s is string => Boolean(s));
  const lookalike = grantedOn.find((d) => normalizeDbName(d) === normalizeDbName(database));

  const who = user ? `Mongo user "${user}"` : "The Mongo user";
  const lines = [
    `${who} has no privileges on database "${database}", which is what MONGODB_URI names.`,
    grantedOn.length
      ? `Its roles (${roles.join(", ") || "see Atlas"}) cover: ${grantedOn.map((d) => `"${d}"`).join(", ")}.`
      : `Its roles (${roles.join(", ") || "see Atlas"}) cover no database.`,
    lookalike
      ? `"${lookalike}" differs from "${database}" only by hyphens/underscores/case; Atlas treats those as two databases.`
      : null,
    `Fix one side: change the database in MONGODB_URI (the path after the host) to a covered name, or in Atlas → Database Access grant the user a role on "${database}". MONGODB_DB_NAME, when set, overrides the URI path.`,
  ].filter((l): l is string => Boolean(l));
  return { ok: false, database, user, grantedOn, message: lines.join(" ") };
}

/** `lnkdrp-dev-csanz`, `lnkdrp_dev_csanz` and `LnkdrpDevCsanz` all fold to the same key. */
function normalizeDbName(name: string): string {
  return name.toLowerCase().replace(/[-_\s]/g, "");
}

/**
 * One line for a code-13 error, from the error alone (no extra round-trip).
 *
 * Parses `not authorized on <db> to execute command { <cmd>: "<collection>", ... }` and drops the
 * rest of the command, which is the caller's filter and of no use to whoever reads the log — or,
 * on the sign-in path, to whoever reads the browser's address bar.
 */
export function explainMongoAuthzError(err: unknown, hint?: { uri?: string }): string {
  const message =
    err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string"
      ? (err as { message: string }).message
      : String(err);
  const m = /^not authorized on (\S+) to execute command \{ (\w+): "([^"]*)"/.exec(message);
  const database = m?.[1] ?? (hint?.uri ? mongoUriDatabase(hint.uri) : "");
  const command = m ? `${m[2]} on "${m[3]}"` : "a command";
  const user = hint?.uri ? mongoUriUser(hint.uri) : null;
  const who = user ? `Mongo user "${user}"` : "the Mongo user";
  const where = database ? `database "${database}"` : "this database";
  return (
    `Mongo refused ${command}: ${who} is not authorized on ${where}. ` +
    `The user authenticated, so the password is right; the role is granted on a different database name ` +
    `(hyphens vs underscores is the usual slip) or not at all. Check the path in MONGODB_URI against the ` +
    `user's roles in Atlas → Database Access.`
  );
}
