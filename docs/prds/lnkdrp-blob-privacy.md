# PRD — Stored artifacts stop being public URLs

**Status:** **Drafted 2026-09-20, awaiting a decision between options B and C.** Nothing here is
built. This is the last finding from the 2026-09-20 security review that is still live, and the
only one that could not be closed by a patch. See `docs/SECURITY.md` §9.
**Owner:** chrissanz
**Last updated:** 2026-09-20
**Project:** lnkdrp
**Sibling docs:** [SECURITY](../SECURITY.md) · [lnkdrp-multi-links](./lnkdrp-multi-links.md) · [lnkdrp-link-access](./lnkdrp-link-access.md)

---

## Problem

Every artifact the upload pipeline produces is written to Vercel Blob with `access: "public"` and
`addRandomSuffix: false` (`src/app/api/uploads/[uploadId]/process/route.ts`), at a path that is a
pure function of two ids (`src/lib/blob/clientUpload.ts`):

```
docs/<docId>/uploads/<uploadId>/preview.png
docs/<docId>/uploads/<uploadId>/extracted.txt      the full text of the PDF
docs/<docId>/uploads/<uploadId>/pages/p0001/image.jpg
docs/<docId>/uploads/<uploadId>/pages/p0001/thumb.jpg
```

No code consults `ShareLink.enabled`, `expiresAt`, `archivedAt`, `passwordHash` or `allowDownload`
before the blob store serves any of them. There is no route in front of them at all.

**The link between "a recipient" and "all of it" is one preview URL.** A recipient of any share
link is handed `doc.previewImageUrl` as an `<img src>` today, and that one URL spells out both ids.
Every other artifact hangs off the same prefix, and the page count is on the page. So a recipient
who opens a link once can, with no tooling beyond a text editor, construct the URL for every page
image and for the complete extracted text of the document — and those URLs keep working after the
link is revoked, expired, password-protected or archived, because nothing about the link was ever
consulted.

The PDF itself is not in this list: it is already served through `/s/:shareId/pdf` and
`/p/:shareId/:docId/pdf`, which apply refusals, the password gate and `allowDownload`. This PRD is
about everything *else* the pipeline wrote, which is most of the document's content in another form.

### Why it survived the review

Every other finding was a rule missing from a handler. This one is not a rule that can be added to a
handler: the bytes are served by a CDN we do not sit in front of. The fixes that shipped on
2026-09-20 narrowed the blast radius — the OG image and the project preview now proxy through our
own origin, and `previewImageUrl` is no longer published as `og:image` — but they moved *our* links
off the store without making the store's own URLs stop working.

### What is not the problem

- **Guessing from outside.** `docId` and `uploadId` are ObjectIds. Enumeration is not the attack.
- **The write path.** `blobUrl` and `previewImageUrl` stopped being patchable, and
  `npm run audit:blob-urls` reports zero stored values off the store.

The attack is a *recipient* keeping what they were shown, and keeping it after the sender took it
back. For a product whose pitch is "revoke a link and it stops working", that is a promise the
product does not keep.

---

## Options

### A. Do nothing, and say so

Change the marketing and the link-settings copy so "revoke" does not imply the page images are gone.

**Cost:** a copy change. **Why it is here:** it is the honest alternative to shipping nothing, and
it is strictly better than the current state, where the UI implies a guarantee that does not hold.
**Why not:** it gives up the guarantee for the case the product is increasingly sold into — a data
room a recipient should not be able to keep.

### B. Proxy the artifacts, like the PDF already is

Write the artifacts `access: "private"` (or keep them public but stop publishing their URLs and
rotate the paths to carry a random segment), and serve every one through a route that re-proves the
link the same way `/s/:shareId/pdf` does.

New routes, mirroring what exists:
```
/s/:shareId/preview            /p/:shareId/:docId/preview      (exists)
/s/:shareId/pages/:n           /p/:shareId/:docId/pages/:n
```

- **Pro:** one mechanism, already proven in this codebase four times this week. Revocation becomes
  immediate and total. The gate order is already written down and tested.
- **Con:** page images are the viewer's hot path. A deck opened by forty investors is forty times
  N page requests that currently never touch our origin. Needs a cache story: `s-maxage` on a
  per-link key buys most of it back, and the OG route already sets that precedent, but it is real
  work and real cost.
- **Migration:** existing artifacts stay where they are and keep working. New uploads write private.
  A backfill can move old ones lazily on first request, or not at all.

### C. Signed URLs with a short life

Keep the artifacts on the CDN, make the bucket private, and hand out time-limited signed URLs minted
by a route that re-proves the link.

- **Pro:** the bytes still come from the CDN, so the hot path stays off our origin. Revocation
  becomes "the current signature expires", which is minutes rather than never.
- **Con:** a signed URL is still a bearer token in a URL, so a recipient can still save one and use
  it until it expires. It narrows the window rather than closing it, and the window is a parameter
  somebody has to choose. Also needs the store to support signing with the lifetime we want, which
  is the first thing to check and is **not yet verified** — if Vercel Blob cannot do this the option
  disappears and B is the answer by default.

### D. Stop producing the artifacts

Render page images in the client from the PDF the viewer already has.

- **Pro:** nothing to protect.
- **Con:** rewrites the viewer, loses the server-side preview the whole product uses in lists,
  emails and unfurls. Not proportionate.

---

## Recommendation

**B, unless C is cheap.** The deciding question is one someone should answer before this is
scheduled: *can Vercel Blob mint signed URLs for a private store, with a lifetime we choose?* If it
can, C is a smaller change with a weaker guarantee, and the weakness is bounded by a number we pick.
If it cannot, B is the only option that closes it, and B is a shape this codebase already knows.

Either way the first shipped piece is the same and is worth doing on its own: **stop handing raw
store URLs to recipients.** The OG image and the project preview already proxy; `/s/:shareId` still
renders `doc.previewImageUrl` directly in its fallback, and that is the one link in the chain that
turns "a recipient" into "every artifact". Closing it does not fix the store, but it removes the
only route a normal recipient would ever find.

---

## Open questions

1. Can the store sign URLs with a chosen lifetime? **This decides B vs C** and nothing else should
   be scheduled before it is answered.
2. What is the acceptable origin cost for page images on a hot deck? B's viability is a cache
   question, not a security one.
3. Do existing artifacts need a backfill, or is "new uploads are private, old ones stay public"
   acceptable given the audit shows the current population is intact?
4. Does `extracted.txt` need to exist in the store at all? It is the full text of a private
   document, it is the most valuable artifact in the list, and the only consumer is the pipeline.
   Moving it out of the store entirely may be a smaller change than protecting it.

## Corrections to existing docs

`docs/SECURITY.md` §9 describes this as "needs signed URLs or a proxy; it is not a patch". That is
right, and this document is the expansion of it. When one of these options ships, §9's entry should
be replaced with a pointer here rather than deleted, because option A's copy problem outlives the
technical fix: whatever we build, the UI should not promise more than it does.
