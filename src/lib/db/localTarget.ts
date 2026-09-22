/**
 * "Is this connection string pointing at a database on this machine?"
 *
 * Asked by `npm run reset`, which drops every collection. The thing that makes that command safe is
 * not care at the keyboard — `MONGODB_URI` is one line in one file and it is the same variable in
 * every environment — it is a check that refuses to run anywhere but here.
 *
 * The rules, and why each one is not negotiable:
 *
 * - **`mongodb+srv://` is always remote.** The scheme means "look this up in DNS SRV", which is how
 *   Atlas and every other managed cluster is addressed. A hosted cluster that happens to be called
 *   `localhost` is still not this machine.
 * - **Every host must be local, not the first one.** A replica-set URI carries a comma-separated
 *   list, and `mongodb://localhost:27017,cluster.example.com:27017/db` connects to the set, not to
 *   the first entry. Checking `hosts[0]` would read that as local and drop the lot.
 * - **`NODE_ENV=production` or a `VERCEL` variable refuses outright**, whatever the host says. A
 *   production process has no business dropping collections even if someone has tunnelled a
 *   database to 127.0.0.1.
 *
 * There is deliberately no override flag. A `--force` on this command would be used exactly once,
 * at speed, by someone who had already stopped reading.
 */

/** Hostnames that mean "this machine". */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]", "::ffff:127.0.0.1"]);

export type LocalTargetVerdict =
  | { local: true; hosts: string[] }
  | { local: false; reason: string; hosts: string[] };

/**
 * Pull the host list out of a Mongo connection string.
 *
 * Deliberately string surgery rather than `new URL()`: a multi-host URI is not a valid URL and
 * `new URL("mongodb://a:1,b:2/db")` reports the whole comma-separated run as one host, which is the
 * mistake this function exists to avoid.
 */
export function mongoHosts(uri: string): string[] {
  const raw = String(uri ?? "").trim();
  const afterScheme = raw.slice(raw.indexOf("://") + 3);
  // Credentials may contain '@'; the host section starts after the last one.
  const at = afterScheme.lastIndexOf("@");
  const hostSection = at === -1 ? afterScheme : afterScheme.slice(at + 1);
  // The host list ends at the database path or the option string, whichever comes first.
  const end = Math.min(
    ...[hostSection.indexOf("/"), hostSection.indexOf("?")].map((i) => (i === -1 ? hostSection.length : i)),
  );
  return hostSection
    .slice(0, end)
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
    .map((h) => {
      // Strip the port, minding bracketed IPv6 (`[::1]:27017`).
      if (h.startsWith("[")) {
        const close = h.indexOf("]");
        return close === -1 ? h : h.slice(0, close + 1);
      }
      const colon = h.lastIndexOf(":");
      return colon === -1 ? h : h.slice(0, colon);
    });
}

/** Would dropping everything at this URI only affect this machine? */
export function isLocalMongoTarget(uri: string, env: NodeJS.ProcessEnv = process.env): LocalTargetVerdict {
  const raw = String(uri ?? "").trim();
  if (!raw) return { local: false, reason: "MONGODB_URI is not set.", hosts: [] };

  if ((env.NODE_ENV ?? "").trim() === "production") {
    return { local: false, reason: "NODE_ENV is production.", hosts: [] };
  }
  // Any of these means the process is running on Vercel, whatever it is pointed at.
  for (const key of ["VERCEL", "VERCEL_ENV", "VERCEL_URL"]) {
    if ((env[key] ?? "").trim()) return { local: false, reason: `${key} is set, so this is a deployed environment.`, hosts: [] };
  }

  if (/^mongodb\+srv:\/\//i.test(raw)) {
    return { local: false, reason: "mongodb+srv:// is a hosted cluster, never this machine.", hosts: [] };
  }
  if (!/^mongodb:\/\//i.test(raw)) {
    return { local: false, reason: "MONGODB_URI does not look like a Mongo connection string.", hosts: [] };
  }

  const hosts = mongoHosts(raw);
  if (!hosts.length) return { local: false, reason: "No host found in MONGODB_URI.", hosts };

  const remote = hosts.filter((h) => !LOCAL_HOSTS.has(h));
  if (remote.length) {
    return { local: false, reason: `Not this machine: ${remote.join(", ")}`, hosts };
  }
  return { local: true, hosts };
}
