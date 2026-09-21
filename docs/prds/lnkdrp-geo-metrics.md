# PRD — Where a document is being read (geo metrics)

**Status:** Draft 2026-09-18, not approved — provider and granularity decided, the rest to lock
**Owner:** chrissanz
**Last updated:** 2026-09-18
**Project:** lnkdrp
**Sibling docs:** [lnkdrp-workspace-metrics](./lnkdrp-workspace-metrics.md) · [lnkdrp-multi-links](./lnkdrp-multi-links.md) · [lnkdrp-link-access](./lnkdrp-link-access.md) · [METRICS](../METRICS.md)

---

## Problem

The metrics page answers *when* a document was read, *how long* for, *which pages*, and — on Pro —
*who* read it. It cannot answer *where from*, which is the first question a sender asks about a link
they sent to a list: "did the London office open it, or only New York?"

We already have the raw material and throw it away. `viewerIp` is written on every ingest path
(`POST /api/share/:shareId/stats`, `POST /api/share/:shareId/landing`, `/s/:shareId/pdf`,
`/p/:shareId/:docId/pdf`) and stored on `ShareView`, `ShareVisit` and `ProjectLinkView`. Its only
consumer today is the admin table at `/a/shareviews`. Nothing turns it into a place.

A map is also the one analytics surface that reads as a *product* rather than a table — it is what
DocSend and Papermark screenshots lead with — and we have a globe in the marketing page's hero
(`public/paperplane/main.js`) that the signed-in app never pays off.

## Goal

On the document metrics page and the workspace metrics page, show where a document's traffic came
from — a map plus a ranked list of countries and cities — derived from the viewer IPs we already
collect, without adding latency to any ingest path and without spending more than a free tier.

## Non-goals (v1)

- Per-visit path-on-a-map, arcs, or animated replay of a reading session.
- Showing a viewer's location on the public share page, or to anyone but the document owner's side.
- Postal-code or street-level precision. City is the floor of the resolution we will ever display.
- A 3D globe in the app bundle. The marketing globe stays where it is (see decision 7).
- Geo in the MCP tool payloads (`lnkdrp_get_share_stats`). Future, cheap once the aggregate exists.
- Blocking or gating access by country. That is a link-access feature, not a metrics one.

## Proposed decisions (to lock)

1. **Provider: IPLocate, via its web API.** 1,000 lookups/day free *forever*, commercial use
   permitted on the free tier, and it returns city, region, country, lat/lng, timezone and ASN
   **plus** VPN / proxy / Tor / hosting flags in the same response. The flags are not a bonus, they
   are decision 4. Key in `IPLOCATE_API_KEY`. Paid tiers (~$25/mo) add a 1,000-IP batch endpoint if
   we ever need it. Alternatives and why they lost: appendix A.
2. **Granularity: city and country.** Decided 2026-09-18. This is what rules out the otherwise
   ideal IPinfo Lite (unlimited and free, but country-only).
3. **One lookup per unique IP, cached in our own collection** (`ipgeos`), keyed by an HMAC of the
   IP. Call volume then tracks *new viewers ever*, not views, which is what keeps a 1,000/day free
   tier comfortable — and hashing the key means the cache holds no raw IP at rest.
4. **Never display a city we do not believe.** Country and region always; city only when the record
   is not flagged VPN, proxy, Tor or hosting. A confidently wrong city ("Sequoia opened it from
   Frankfurt" — it was a VPN exit) is worse for the owner than no city at all.
5. **The lookup never touches the request path.** Resolution happens in `after()` — the same
   deferred-work idiom the ingest routes already use (`src/app/api/share/[shareId]/stats/route.ts:356`,
   `.../landing/route.ts:111`) — behind a short timeout, and any failure leaves `geo` null for that
   row to be retried on the viewer's next visit. A provider outage costs us a blank map cell and
   nothing else.
6. **Plan gate, following the viewer-identity rule.** Country-level aggregate counts on Free (a
   shape with no identity in it); city-level and any per-viewer location on Pro, never serialized
   for a Free workspace, the same "withheld, not hidden" construction `loadWorkspaceMetrics`
   already uses. *To lock: whether Free sees country counts at all, or nothing.*
7. **A 2D map, not a globe, and no CDN.** `react-simple-maps` (MIT, 217 KB unpacked, peer-deps
   already allow React 19) with one vendored `world-atlas` topojson file served from `public/`.
   The privacy policy states that the CDN map fetch happens on the marketing page only and that
   "No such requests are made inside the signed-in app" — that stays true. `react-globe.gl` is
   refused on weight (17 MB unpacked, pulls three.js into the app bundle).
8. **Two privacy-policy edits ship in the same PR as the feature, not after it.** Section 5 today
   promises the viewer "Your IP address ... is not shown to the document owner", and a city on a
   map is IP-derived location shown to the document owner. Section 4.2's service-provider list
   gains IPLocate as a recipient of viewer IPs.

## Approach

### Data model

**`IpGeo` (new, `ipgeos`)** — the lookup table, one document per unique IP ever seen:

```
{ ipKey,            // HMAC-SHA256(ip, GEO_IP_HMAC_SECRET) — unique index, no raw IP at rest
  status,           // "ok" | "unknown" | "failed"
  countryCode, country, regionCode, region, city, lat, lng, tz,
  asn, org,
  flags: { vpn, proxy, tor, hosting },
  source,           // "iplocate"
  fetchedAt, failCount, createdDate, updatedDate }
```

Indexes: `ipKey` unique; `fetchedAt` for the staleness sweep. The collection is small by
construction — its cardinality is unique viewers, not views.

**Denormalized snapshot on the view rows.** `ShareView`, `ShareVisit` and `ProjectLinkView` each
gain `geo: { countryCode, country, region, city, lat, lng } | null`, written at resolution time.
This is deliberate duplication, for the reason already written on `ShareView.orgId`: a
workspace-level question must be one indexed scan, not a `$lookup` into another collection on the
hot path. Written with `$set` (never `$setOnInsert`) so a pre-existing row self-heals on the next
visit — the `shareLinkId` precedent from [lnkdrp-multi-links](./lnkdrp-multi-links.md).

### Resolution

`src/lib/geo/resolve.ts` exports one function, `resolveGeo(ip): Promise<Geo | null>`, with the
provider behind `src/lib/geo/providers/iplocate.ts`. Swapping providers later is then one file,
because every caller and every stored row speaks our normalized shape.

The order inside `resolveGeo`:

1. **Reject what must never be sent.** Private, loopback, link-local and reserved ranges return
   null without a network call.
2. **Bounded in-process LRU**, the same idiom as the cache in
   `src/app/api/metrics/workspace/route.ts`. A warm function resolving one viewer's IP a dozen
   times during a reading session must not reach Mongo, let alone IPLocate.
3. **`ipgeos` lookup by `ipKey`.** A hit newer than the staleness window returns immediately.
   A hit with `status: "unknown"` also returns immediately — **negative caching matters**: without
   it, an IP the provider cannot place is re-queried on every view of every document, forever.
4. **Daily budget check**, via the existing Mongo `rateLimit()` bucket under a fixed key
   (`geo:lookups:day`, default 900/day so we stay inside the free tier with headroom). Exhausted
   means we stop calling for the day and leave rows null; they resolve on a later visit.
5. **The call**, with `AbortSignal.timeout(~1500ms)`. Upsert the result on the unique index and
   swallow duplicate-key errors: two concurrent views from one IP will race, and one losing is the
   correct outcome.

**Staleness is lazy, never a cron.** A row older than ~60 days is re-resolved *the next time that
IP appears*. A scheduled job that refreshes every IP we have ever seen is the single most reliable
way to turn a free tier into an invoice.

### Aggregation

One more `$group` alongside the existing ones in `src/lib/analytics/workspace/query.ts` and the
document metrics route, matched by `orgId` / `docId` and bounded by the same activity window, with
`RECIPIENT_ONLY_MATCH` applied exactly as every other owner-facing aggregate applies it — an owner
previewing their own link must not appear on their own map. Output: ranked countries (views, unique
viewers) and, on Pro, ranked cities.

### Web app

A **"Where it's read"** card on the document metrics page and the workspace metrics page:
the map, and beside it the ranked list that is what people actually read. Empty state before
anything resolves, and a plain country list on narrow screens instead of a squeezed map.

This adds a surface; it changes no existing one. In particular the time-series charts remain smooth
area charts with value labels — the map is not a licence to revisit them.

### Retention

Once `geo` is denormalized onto the view rows, the raw `viewerIp` is no longer load-bearing for the
map. That makes it droppable on a TTL matched to the abuse-prevention purpose the privacy policy
actually claims for it, which is a strictly better position than today's indefinite retention — and
it is the change that makes the section 5 rewrite defensible rather than awkward.

## Verification

1. Views seeded from known IPs (the share seed corpus) produce the expected countries and cities.
2. A second view from the same IP makes **zero** provider calls — asserted on a counter, not by eye.
3. Provider timeout or 5xx: the view is still recorded in full, `geo` stays null, nothing surfaces
   to the viewer or the owner, and the next visit from that IP retries.
4. A private/reserved IP never reaches the network.
5. With the daily budget exhausted, no further calls are made that day and ingest is unaffected.
6. A row flagged VPN/proxy/hosting shows its country and region and **no** city.
7. A Free workspace's metrics payload contains no city and no per-viewer location — checked on the
   serialized response, the way the identity gate is checked.
8. The document map and the workspace map agree for the same range, as the existing reconcile tests
   require of every other figure.

## Milestones

### M1 — Resolver, cache, denormalization (no UI)
`IpGeo` model, `resolveGeo` + IPLocate adapter, budget guard, `after()` wiring on all four ingest
paths, `geo` on the three view models. Proves: verification 2–5, and that nothing visible changed.

### M2 — The map
Aggregation in both metrics queries, the "Where it's read" card, the Pro gate. Proves: 1, 6, 7, 8.

### M3 — Policy and retention
Privacy policy sections 4.2 and 5; `viewerIp` TTL. Ships with or before M2 reaching production.

### M4 — Backfill (optional)
The IPs already in Mongo, either drained against the free daily budget over several days or in one
pass on a single paid month with the batch endpoint. Skippable: the map can simply start at launch.

## Open questions

1. Does Free see country counts, or is the whole card a Pro surface? (Decision 6.)
2. Retention window for raw `viewerIp` once `geo` exists — what does abuse prevention actually need?
3. Is the backfill worth one paid month, or does the map start forward-only?
4. Map form: choropleth by country, or dots at city lat/lng? Dots read better for the handful of
   viewers a real document has; choropleth reads better at workspace scale. Possibly both, by scope.

## Future

- Geo in `lnkdrp_get_share_stats` so an agent can say "opened from London twice".
- "Opened from a new country" as a view-notification trigger.
- Country-based link access rules (allow/deny), which belongs to
  [lnkdrp-link-access](./lnkdrp-link-access.md), not here.

---

## Appendix A — Provider comparison (researched 2026-09-18)

| Provider | Free tier | Commercial on free? | City | Batch | Paid entry |
|---|---|---|---|---|---|
| **IPLocate** *(chosen)* | 1,000/day, free forever | yes | yes, + VPN/proxy/Tor/hosting flags | paid only, 1,000/call | ~$25/mo |
| ipwhois.io | 1,000/day, no API key | yes | yes | none | paid tiers |
| IPinfo Lite | unlimited | yes (CC BY-SA, attribution) | **no — country + ASN only** | — | Core $49/mo |
| ipgeolocation.io | 1,000/day | **no — non-commercial** | yes | paid only | $19/mo |
| ipapi.co | 1,000/day, "not meant for production" | effectively no | yes | GUI only | $15/mo |
| ipdata.co | 1,500/day | **no — non-commercial** | yes | yes | $10/mo |
| ip-api.com | 45/min | **no — non-commercial** | yes | 100/call | $15/mo |
| ipstack | 100/**month** | yes | yes | paid | $12.99/mo |

**Rejected outright:**

- **MaxMind GeoLite2**, database *or* web service, despite being the accuracy benchmark. Its EULA
  covers "internal restricted business purposes" and excludes using the data in a B2B product or
  displaying extracted data points to people outside your organization — which is precisely what
  showing a viewer's city to a document owner is. It needs a paid commercial licence, and the trap
  is that nothing technical stops you, so it is easy to ship and only discover later.
- **Bundled mmdb files** (DB-IP City Lite at ~19 MB and CC BY 4.0 with a required link back,
  IP2Location LITE under CC BY-SA). Workable and licence-clean, but rejected on the user's
  preference for a service we ping over a database file living in the repo and deployed into
  functions.
- **`geoip-lite`** — 115 MB unpacked, and MaxMind-derived, so it inherits the licence problem above.

**Noted, not used:** Vercel sends `x-vercel-ip-country`, `-country-region`, `-city`, `-latitude`,
`-longitude`, `-timezone` and `-postal-code` on every request, free, on all deployments. It is the
zero-cost fallback for rows where IPLocate fails, and the reason we are never locked in.

Sources: [IPLocate pricing](https://www.iplocate.io/pricing) · [IPinfo Lite](https://ipinfo.io/lite) ·
[ipgeolocation.io ToS](https://ipgeolocation.io/tos.html) · [ipapi.co pricing](https://ipapi.co/#pricing) ·
[ipwhois.io docs](https://ipwhois.io/documentation) ·
[MaxMind commercial GeoLite licence](https://support.maxmind.com/knowledge-base/articles/commercial-license-for-geolite) ·
[DB-IP Lite](https://db-ip.com/db/lite.php) · [Vercel request headers](https://vercel.com/docs/headers/request-headers)
