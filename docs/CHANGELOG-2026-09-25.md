# Changes — 25 September 2026

On the `next-release` branch; nothing here is on `main` yet. Grouped by what it affects.

---

## A document's home project, and staying inside it (new)

Decided and built in one day (`docs/prds/lnkdrp-project-home.md`), after the data-room test
showed a document announced to the whole workspace a moment before it joined its room.

**Upload into a data room.** The upload page has an "Add to a data room" picker (preselected
by `/upload?project=<id>`, which is where a project page's new "Upload here" button goes), the
API takes `POST /api/docs { projectId }`, and the MCP takes
`lnkdrp_share_pdf { projectId | projectSlug }`. The document is in the room from its first
write, so there is one creation event: the feed row reads "… in Data room", Slack's "was added
to Data room" post goes to the room's channel, and no "added to project" row follows. A request
inbox is refused: files are received there, not uploaded.

**Contained documents.** A document can be kept inside its data room only. It leaves every
workspace-wide list (the Docs sidebar, `/api/docs`, search, tags, starred, recent changes, the
dashboard, workspace metrics, suggested documents, `lnkdrp_list_docs`) through one shared filter
that a test pins to each listing; its activity rows leave the workspace feed and show under the
project's; Slack routes it to the room's channel or nowhere. Its direct link, metrics, history and
links keep working. Set it at upload ("Only inside this data room"), from the document menu,
`PATCH /api/docs/:id { visibility }` or `lnkdrp_set_doc_visibility`; a contained document refuses a
second project. This is the containment that private projects will build on.

## Slack

- **A data-room introduction names the reader everywhere.** A reader who introduces themselves
  on a data room's landing page was "Someone" in Slack posts, visit briefs and on the reader page,
  while the activity feed named them. One helper now reads the arrival row and the share views
  the same way the feed does, and the brief row stores the name.
- **Introductions post.** "Nadia Okafor introduced themselves on Data room via Sequoia Capital",
  under the Opens switch, on Free too.
- **New documents and new links post.** A document that finished uploading and a document added
  to a room post under "New documents"; a new document or data-room link posts under "Replaced
  documents and links".
- Switches read on and off; the routing copy says what each card does; the reader's name links
  to their metrics page.

## Fixes found by the data-room drive

- **The owner PDF viewer could pin the previous version for a year.** The upload route points a
  document at the new upload before its bytes exist, and the PDF route answered the versioned URL
  with the old blob under an immutable header. The route now redirects a versioned request to
  that upload's own blob, cacheable only once it exists.
- **AI compare failed on a long sentence.** The storage caps sat on the schema handed to the
  model, so one over-long summary failed the whole compare after charging. The answer is now
  clipped after the fact.
- **Visit briefs are charged** (one credit each, verified in the ledger) and reach the feed, the
  email and Slack.
