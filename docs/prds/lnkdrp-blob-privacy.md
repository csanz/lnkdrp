# PRD — Stored artifacts stop being public URLs

**Status:** **Drafted 2026-09-20. The blocking question is answered: option C does not exist, so
the design is B, and a cheap first step (B0) can ship on its own.** The recipient-facing half is
already done — no page hands out a store URL any more. What remains is the store itself.
See `docs/SECURITY.md` §9.
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

**The link between "a recipient" and "all of it" is one preview URL.** Until 2026-09-20 a recipient
of any share link was handed `doc.previewImageUrl` as an `<img src>`, and that one URL spells out
both ids. Every other artifact hangs off the same prefix, and the page count is on the page. So a
recipient who opened a link once could, with no tooling beyond a text editor, construct the URL for
every page image and for the complete extracted text — and those URLs keep working after the link is
revoked, expired, password-protected or archived, because nothing about the link was ever consulted.

**No page hands out a store URL any more.** The OG image, the data-room grid and both "still
preparing a PDF viewer" fallbacks proxy through our own origin now, each re-proving the link and its
password. That closes the *handing over*. It does not close the store: anyone who saved such a URL
before those fixes still has it, and still has everything derivable from it, permanently.

The PDF itself is not in this list: it is already served through `/s/:shareId/pdf` and
`/p/:shareId/:docId/pdf`, which apply refusals, the password gate and `allowDownload`. This PRD is
about everything *else* the pipeline wrote, which is most of the document's content in another form.

### Why it survived the review

Every other finding was a rule missing from a handler. This one is not a rule that can be added to a
handler: the bytes are served by a CDN we do not sit in front of. The proxies that shipped on
2026-09-20 moved *our* links off the store; they did not make the store's own URLs stop working, and
nothing we can write in this repo will, because the store has no access control to configure (see
option C).

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

### C. Signed URLs with a short life — **ruled out, the store cannot do it**

Checked against `@vercel/blob` v2.0.0, which is what is installed:

```ts
// node_modules/@vercel/blob/dist/create-folder-C02EFEPE.d.ts
/** Whether the blob should be publicly accessible. The only currently allowed value is `public`. */
access: 'public';
```

`access` is a literal type with one member. There is no private store to sign for, and the only
URL-minting export, `getDownloadUrl`, just appends `?download=1` — it is a content-disposition
helper, not a signature. So the option is not available, and B is the answer by default rather than
by preference.

This also means **a URL that leaks is public forever**, with no expiry to fall back on, which
raises the value of B0 below.

### B0. Make the paths unguessable — ships on its own, today

`put()` takes `addRandomSuffix`, which the pipeline currently sets to `false`
(`src/app/api/uploads/[uploadId]/process/route.ts`). That single flag is why the paths are a pure
function of `(docId, uploadId)`, and it is the entire reason one preview URL yields every other
artifact.

Turn it on and the chain breaks at its root: knowing the preview URL tells you nothing about the
page images, because each carries a random segment nobody can derive. The bytes are still public to
anyone holding a specific URL — this is not B — but "a recipient who saw one thing" stops being
"a recipient who has everything", which is the actual complaint.

- **Cost:** one flag, plus storing the returned URL rather than recomputing the path. The pipeline
  already stores what `put()` returns, so the second part may be free; the reader
  (`src/lib/blob/clientUpload.ts`) derives paths and would need to stop.
- **Migration:** existing artifacts keep their guessable paths. A backfill can re-upload, or not —
  every new upload is safe from the day it ships.
- **Why it is not enough alone:** a URL a recipient did save still works after revocation. It
  narrows who can get what, not how long.

### D. Stop producing the artifacts

Render page images in the client from the PDF the viewer already has.

- **Pro:** nothing to protect.
- **Con:** rewrites the viewer, loses the server-side preview the whole product uses in lists,
  emails and unfurls. Not proportionate.

---

## Recommendation

**B0 now, B when there is appetite.** C is gone, so there is no shortcut: the only way to make
revocation real is to put a route in front of the bytes.

But B0 is one flag and buys most of the practical protection, because the complaint is not "a
determined recipient kept a file". It is "a recipient who was shown one page can reconstruct the
whole document, including its full text, and keep it after the link is revoked". `addRandomSuffix`
severs that inference on its own, and it can ship in an afternoon without touching the viewer's hot
path.

**Already done, 2026-09-20**, and it was the other half of the same problem: no page hands a
recipient a store URL any longer. The OG image, the data-room grid and both "still preparing"
fallbacks proxy through our own origin, each re-proving the link and its password. A recipient is
no longer *handed* the key to the prefix — B0 makes the prefix stop being a key at all.

---

## Open questions

1. ~~Can the store sign URLs with a chosen lifetime?~~ **No.** `access: 'public'` is a one-member
   literal type in `@vercel/blob` v2.0.0. C is ruled out; see that section for the evidence.
2. Does `addRandomSuffix: true` break anything that recomputes a path rather than reading the stored
   URL? `src/lib/blob/clientUpload.ts` derives all four paths, so this is the one real question B0
   has, and it is a code question with a definite answer rather than a judgement call.
3. What is the acceptable origin cost for page images on a hot deck? B's viability is a cache
   question, not a security one.
4. Do existing artifacts need a backfill, or is "new uploads are unguessable, old ones stay as they
   are" acceptable given `npm run audit:blob-urls` shows the current population intact?
4. Does `extracted.txt` need to exist in the store at all? It is the full text of a private
   document, it is the most valuable artifact in the list, and the only consumer is the pipeline.
   Moving it out of the store entirely may be a smaller change than protecting it.

## Corrections to existing docs

`docs/SECURITY.md` §9 describes this as "needs signed URLs or a proxy; it is not a patch". That is
right, and this document is the expansion of it. When one of these options ships, §9's entry should
be replaced with a pointer here rather than deleted, because option A's copy problem outlives the
technical fix: whatever we build, the UI should not promise more than it does.
