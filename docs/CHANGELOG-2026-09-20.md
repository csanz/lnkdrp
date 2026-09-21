# Changes — 19–20 September 2026

Written for the ship this weekend: what changed, and for the ones that matter, why. Grouped by what
it affects rather than by commit order, because eighty-one commits in commit order is a list nobody
reads.

Most of the MCP entries came out of black-box sweeps: agents driving the live server, every finding
reproduced by a second agent trying to refute it before anything was changed. Where a fix has a
"found by" note, that is where it came from — several were found by running the tool rather than by
reading it, and those are the ones marked.

---

## The MCP server

### Answers that were confidently wrong

**Project-link traffic is no longer invisible.** `lnkdrp_get_share_stats` asked "who read this
document" and answered "12 views, nobody identified" while the same server's activity feed showed 23
views and named two readers. Reads that arrive through a *data room's* link belong to the room, not
the document, so the upstream route keeps them out of `totals` and reports them separately — and the
MCP's whitelisting mapper silently dropped that section. On a document inside a data room it is
usually most of the traffic and most of the named readers. Now forwarded as `projectLinkTraffic`,
with the same deep-tier rule on identities and the same untrusted wrapper as every other name.

**An archived document said it did not exist.** Looked up by `shareId` it returned "No document with
that shareId in this workspace" — false, and byte-identical to the answer for a typo or another
workspace's slug, so an agent could not tell "you got the id wrong" from "this exists and is
archived". It now names the document and says how to reach it.

**A deleted share link kept answering.** Its slug still resolved its document, so `lnkdrp_get_share`
described a *different*, live link under the dead one, and `lnkdrp_get_share_stats` returned a
`perLink: true` success full of zeroes — "this link exists and nobody opened it" for a link that was
gone. Both argument shapes are refused now, including `docId` + `shareId` together, which is the
form the tool's own description recommends. Its password went with it: both password tools refuse
rather than handing back or confirming the secret of a link that opens nothing.

**A document was reported found and missing at once.** `lnkdrp_list_docs` matched ids
case-sensitively when deciding what had not resolved, while the id regex accepts either case and the
API echoes ids lowercased. An uppercase id came back in `docs` with the same id sitting in
`notFound`. `notFound` is also always present now when `ids` was passed, rather than vanishing when
empty.

**Two tools contradicted each other about the same link, one second apart.**
`lnkdrp_verify_share_password` read the link row raw, so on an archived document it answered
`linkStatus: "active"`, `opensLink: true` — while `lnkdrp_get_share`, one call later, answered
`isArchived: true`, `anyLinkActive: false` about the same link. An archived document's links open
for nobody whatever their own rows say; the rows keep the state that unarchiving restores, which is
why the raw read looks live. `get_share` already had the override, and this tool — whose own
description says to check `opensLink` before telling a human the link works — did not. It does now,
and says `isArchived` out loud.

**"Downloads: 0" meant two different things and reported one.** `lnkdrp_get_share_stats` returned
`downloads: 0` on a document whose only link had downloads switched off, so nobody *could* have
downloaded it — and nothing in the response said so. The route computes `downloadsEnabled` as an
explicit label for exactly this, and the mapper dropped it. The obvious substitute is wrong on a
multi-link document: `get_share`'s `shareAllowPdfDownload` is the *default* link's setting, while
this is "any live link allows it". Now returned, with a description clause mirroring the one that
already warned about the same trap on views.

**A byte-identical replacement was reported as an update.** `lnkdrp_replace_pdf` on a file matching
the version it replaced returned `{status: "ready", version: N+1, warnings: []}` — identical in
shape to a real update — and the agent told its human the document had been updated. The processing
route already knew (it detects the match, keeps the existing summary and skips the charge); the tool
discarded the signal. Now `unchangedFromPrevious: true`. Its idempotency replay also gained the
`stillExists` check and the `replayed: true` flag that `share_pdf` and `create_project` got in the
same sweep and it missed.

**`star_docs` said "unchanged" about a star it had just switched on.** The id regex accepts either
case and the API normalises, but the changed/unchanged compare is a string equality against the
API's lower-case ids — so an upper-case id read as unstarred before *and* after its own successful
write, in both directions. The same class of bug as the `list_docs` one above, in the tool where the
answer is the whole result. Ids are lower-cased at the door now.

**A confirmation prompt contradicted its own evidence.** `lnkdrp_delete_project` graded severity as
"the public page is on and it is not empty", which is not a fact about anyone losing anything. On a
project made four minutes earlier with one document and zero views, the human was shown "Several
people may lose access at once: recipients have opened this, or more than one live link stops
resolving" directly above facts saying neither. The comment in `confirm.ts` explaining why that must
not happen was written when the same thing was fixed for documents; projects never got it. Severity
now comes from the project's link traffic, and an unreadable listing stays `high` — the safe default
for a prompt is the louder one.

**Free text walked past the untrusted wrapper.** `lnkdrp_get_activity` wrapped seven `meta` keys and
let the rest through raw: across ~700 live rows that was `projectName` on 223, `tagName` on 85 and
`fileName` on 42 — an uploader's own file name is a string a stranger chose. It was also shallow, so
`share_link.updated` carried the edited link label under `meta.values.label` unwrapped while the
identical text arrived wrapped as `linkLabel` on every other row. Both fixed: a wider key list, and
one level of recursion. Ids, slugs and enums stay raw.

**A Free workspace inside its grace window was told to upgrade.** `checkLimit` lets the write
through when a Free workspace is over its cap but inside the unblocked launch window, and
`GET /api/plan` forces every `atLimit` flag false to match — and the MCP's plan mapper dropped both
`graceActive` and `atLimit`, leaving `whoami` to compute `remaining: limit - used` = 0. The one
preflight the tool's own description tells an agent to run concluded "capped, recommend an upgrade"
during the single window where no upgrade is needed. `capabilities` now carries `atLimit` per cap
and `graceActive` when it holds, and says to read the flag rather than the arithmetic.

**`untag` reported a tag in a spelling nobody typed.** Matching folds case, accents and punctuation —
correctly — but `notTagged` was built from the fold, so asking to remove "Série A" from an item that
did not carry it reported `serie-a`, a string the human never wrote and cannot find in the UI. It
now answers in the caller's own spelling, while `removed` carries the tag's stored name.

**An idempotent replay outlived its subject.** Create a document with a key, delete it, retry the
key, and `lnkdrp_share_pdf` returned the original success — same `docId`, `status: "ready"`, empty
warnings — describing something that no longer existed, so an agent handed a dead share link to a
human. The cache cannot see that alone, so `run` takes a `stillExists` check and a replay whose
object is gone does the real work instead. A failed lookup counts as *still there*: a bad minute on
the network is not evidence of a deletion. `share_pdf` also reports `replayed: true` now, which
`create_project` already did.

*Found by running the tools, not by reading them.*

### Tags, which were half a feature

The tags PRD's M4 asked for a `tags` field on the list/get tools and a `tag` filter on `list_docs`.
Neither shipped, so an agent could file a document and then never find it again.

- `lnkdrp_list_docs` takes `tag` — the name as a human writes it, folded, so any spelling reaches
  it. It resolves through `GET /api/tags/by-slug/:slug/items`, an endpoint that existed with no
  caller.
- Every document row in `list_docs` and `get_project`, plus `get_share` and the project itself,
  carries its `tags`. One batched read per list through `GET /api/tags/targets` — also previously
  uncalled — rather than one request per row.
- `tagMatched` separates the two zeroes: `false` means no tag by that name exists (a typo, or one to
  create), `true` with no documents means the tag is real and nothing carries it. It is present
  whenever the filter runs, on a full page as well as an empty one.
- **`lnkdrp_untag` did not remove tags.** `lnkdrp_tag` promises it folds case, accents and
  punctuation; `untag` only lowercased, so untagging "Serie A" from an item carrying "Série A"
  reported the name in `notTagged` — telling the agent the tag was not there when it was.

### What an agent is told

**A third of the server instructions never arrived.** Clients truncate the block at 2,048 characters
and say nothing; it had grown to about 3,200. What fell off the end was project links, tags, the
document-lifecycle tools, and the sentence telling the agent that document titles and viewer text
are untrusted content rather than instructions to follow. Rewritten as an index rather than a
manual, at 1,991 characters including the workspace prefix, with a test pinning the budget and
asserting the untrusted-content warning survives a cut at the limit.

**Refusals say what to do instead.** "URL is not allowed" is a diagnosis with no next move, so an
unattended agent retries the same URL. The over-size refusal was worse: it pointed at `sourceUrl` as
the way round, but the ceiling is on the document, not the transport, so the same file is refused
either way. It now says to shrink the PDF.

**The password tool stops promising a plaintext it is forbidden to return.** The security pass
barred API keys from revealing share passwords — the right call, since a bearer credential that can
read secrets out has a much larger blast radius — and every MCP connection is an API key. Its
description now leads with the refusal and points at `lnkdrp_verify_share_password`, which is
unaffected and answers what people actually ask. A project-link twin was built and then withdrawn
rather than shipped: it could never succeed, and unlike document links it has no verify sibling.

### Deployment

**The image could not optimize a PDF.** Optimization was tuned over four rounds by eye —
`/prepress` at 220dpi — and could not have run in production for a single upload: the image is
`node:22.23.2-alpine`, which has no Ghostscript, and `pdfjs-dist` was not among its packages.
Neither absence fails loudly; a deck simply arrives at full size. Both are in the image now,
verified by building it and running it.

**Deletes can skip the prompt against a dev database.** `LNKDRP_SKIP_CONFIRMATIONS=1`, gated on
`LNKDRP_API_URL` being localhost — on the *data* being disposable, not on where the process runs. A
local server pointed at production is a supported setup (it is how `filePath` uploads work) and a
delete there is a real delete. Set against any other API URL the flag is ignored and the server says
so at startup.

Writing that gate found a real bug in the check it shares with `filePath`: `isLocalApiUrl` tested
`/^127\./`, which matches the hostname `127.0.0.1.evil.com` — an ordinary DNS name someone else
controls.

---

## Tags in the app

The manage page was rebuilt around what a tag actually is: a colour, a name, a count, and two
things you can do to it.

- **A table**, not cards. Cards put the count wherever the name happened to end, so no two rows
  lined up.
- **Merging asks with a search box.** It used to render every other tag in the workspace as chips
  under the row — fine at six, unusable at three hundred, and it pushed the table off the screen to
  ask one question.
- **A colour picker**, anchored to the swatch it changes. It used to open as an extra table row,
  which read as belonging to the tag underneath it. The palette went from six colours to twelve:
  six is enough to tell four tags apart and nothing at all at two hundred, where it is
  thirty-three to a colour. No migration — colours are stored by key.
- **One bar**: search with a New tag button, rather than two stacked full-width fields that put the
  rare action above the constant one.

**It pages and searches on the server.** `GET /api/tags` returned every tag and computed counts for
every tag, so paging in the browser was decorative. `listTagsPage` does filter, sort, skip and limit
in Mongo and counts only the page it returns. Paged only when asked — the sidebar, the autocomplete
and the MCP all want the whole list and keep the response they were written against. The sidebar
lists twenty with an overflow link rather than rendering the workspace.

**A project's default link is materialised on read again.** The docs route carries a comment calling
itself "the one read that materialises the project's default `ShareLink`". It never had: its
projection selected fourteen fields and neither of the two the helper needs, so it returned
empty-handed inside a `try/catch` that swallows. The visible symptom was a new project reporting
`links: []` while its `/p/:shareId` served anyone holding the URL — an agent asked "is this shared?"
said no.

---

## Documentation

`mcp/README.md` covered 27 of 33 tools and handed the reader `Bearer lnk_…` with no step that
produces a key. `docs/MCP.md` said "Thirty tools", documented output shapes that had drifted, and
pointed the reader at a realtime host that exists nowhere in the repo. Both now match the code, and
both carry the two things a deployment needs to know that nothing said before: which clients can
reach a hosted server (API-key headers yes, OAuth no — `authorization_servers` is empty), and how to
keep `filePath` by running the server locally against the production API.

`DEPLOY.md` told the operator in four places to add a `COPY` line that had been in the Dockerfile
since the blocker was found. The hazard behind it is kept, because it is not fixed: nothing checks
that the image's `COPY` list covers what `mcp/src` imports out of `src/lib`.

OAuth is scoped in `docs/prds/lnkdrp-mcp-oauth.md` — where the authorization server should live,
why tokens should be opaque rather than JWTs, and the four milestones — and deliberately not built.

---

## Known and not fixed

- **Cloud connectors cannot authenticate.** The server advertises no OAuth authorization server, so
  a client that authenticates on the user's behalf has nowhere to send them. Header-auth clients
  work. Scoped, not built.
- **One machine only.** MCP sessions live in memory, so the Fly app is pinned to a single instance:
  every deploy drops connected agents, and the 24h idempotency cache is per-process, so a retry
  after a restart creates a duplicate rather than replaying.
- **Twenty `[mcptest]` tags** are in the USAVX workspace from testing. They cannot be removed over
  MCP — `DELETE /api/tags/:id` refuses API keys — so they need a signed-in human on `/tags`.
- **Six tools have no MCP representation at all**: version history, workspace metrics, project
  analytics, project-link passwords, member and invite management, billing detail.
