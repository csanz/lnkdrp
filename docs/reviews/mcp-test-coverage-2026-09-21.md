# MCP test coverage

What has actually been tested on the MCP surface, by what, and what has never been touched.

Thirty-three tools, six manual sweeps, ninety-five commits to `mcp/src` since the server shipped on
2026-09-13 — forty-eight of them fixes. The server is in good shape. What is not in good shape is
the *record*: most of that testing happened by hand in agent sessions, the findings live in session
scratchpads, and the one automated harness covers two thirds of the tools while asserting that all
thirty-three exist. This document is the thing that was missing, not a plan to test more.

Read section 2 if you skip the rest. It is the list of tools nothing will catch a regression in.

> **2026-09-25.** Section 2 is now historical: the harness drives all thirty-six tools (the three
> revision tools arrived on 2026-09-24) and cleans up after itself. The rows are annotated in place.
> See `docs/reviews/mcp-test-run-2026-09-24.md` for the seven passes that got it there.

Counts and line references were correct on 2026-09-21. Search by symbol.

---

## 1. What exists

| What | Where | Scope |
|---|---|---|
| Wire-level e2e harness | `tests/mcp/e2e.ts`, 1,645 lines, 58 steps, about 240 assertions (updated 2026-09-25) | Mints a real API key in Mongo, connects an MCP client over Streamable HTTP, drives **all 36 tools** in the order an agent uses them, deletes what it made (document, project, tag), revokes the key. No test framework on purpose. |
| Analytics harness | `tests/mcp/analytics.ts` | `get_share_stats` and `list_share_links` against generated traffic. |
| Unit tests | 9 files, `tests/lib/mcp*.test.ts` | Cross-cutting machinery plus the round-six regressions. Detail in section 3. |
| Contracts | `mcp/README.md` (653 lines), `docs/MCP.md` | What each tool takes and returns, and why. Not coverage. |
| Defect history | `docs/CHANGELOG-2026-09-20.md` | What the sweeps found, written by impact rather than by tool. |
| PRDs | `docs/prds/lnkdrp-mcp.md` (`prd_thRjwCQvKg`), `docs/prds/lnkdrp-mcp-oauth.md` | Built, and scoped-not-built. |

### How to run each one

```
npm run dev                                          # :3001, the REST API the server calls
npm run mcp                                          # :8787
npm run realtime                                     # optional; skips polling on share_pdf
npx tsx --env-file=.env.local tests/mcp/e2e.ts       # add --fast in CI to drop the pacing gaps
npx vitest run --config tests/lib/vitest.config.ts   # the config is not optional
```

Two traps that have each cost a session. `next dev` on the Synology path serves pre-edit code, and
so does the tsx MCP server — **restart both before trusting any live result**; three phantom bugs
came from this. And `vitest` without `--config tests/lib/vitest.config.ts` invents failures.

---

## 2. The coverage matrix

`e2e` means the harness invokes it with assertions, not that every field is asserted. `list-only`
means the tool appears in `EXPECTED_TOOLS` — the array asserting `tools/list` returns all
thirty-six — and nowhere else in the file.

**Updated 2026-09-25.** The eleven gaps below were closed in `f6bd055` and `5f00a05`, and the three
revision tools added in `5990790` came with their own steps. Every tool now has at least one
asserted step; the counts are invocations in `e2e.ts`. The original rows are kept as they were
written, struck through, so the history of what was untested stays visible.

| Tool | e2e | unit | hand-probed | verdict |
|---|---|---|---|---|
| `whoami` | ✅ ×3 | `instructionsBudget`, `roundSix`(`atLimit`) | ✅ | covered |
| `list_docs` | ✅ ×2 | — | ✅ | covered |
| `get_activity` | ✅ ×4 | `roundSix` (meta wrapping) | ✅ | covered |
| `share_pdf` | ✅ ×3 | `resolvePdfSource`, `idempotency` | ✅ | covered |
| `replace_pdf` | ✅ ×5 | `resolvePdfSource`, `idempotency` | ✅ | covered |
| `get_share` | ✅ ×2 | — | ✅ | covered |
| `set_share_access` | ✅ | — | ✅ | covered |
| `get_share_stats` | ✅ ×2 | `roundSix` (`downloadsEnabled`) | ✅ | covered |
| `create_share_link` | ✅ | — | ✅ | covered |
| `list_share_links` | ✅ ×5 | — | ✅ | covered |
| `find_share_link` | ✅ ×2 | — | ✅ | covered |
| `verify_share_password` | ✅ ×2 | `roundSix` (archived) | ✅ | covered |
| `get_share_link_password` | ✅ ×2 | — | ✅ | covered |
| `update_share_link` | ✅ ×5 | — | ✅ | covered |
| `delete_share_link` | ✅ ×2 | `confirm` | ✅ | covered |
| `create_project` | ✅ | `idempotency` | ✅ | covered |
| `add_docs_to_project` | ✅ | — | ✅ | covered |
| `create_project_link` | ✅ ×2 | — | ✅ | covered |
| `list_project_links` | ✅ ×6 | — | ✅ | covered |
| `update_project_link` | ✅ ×2 | — | ✅ | covered |
| `delete_project_link` | ✅ ×4 | `confirm` | ✅ | covered |
| `delete_project` | ✅ | `confirm` | ✅ | covered |
| `archive_doc` | ✅ ×2 | `instructionsBudget` | ✅ | covered (~~was list-only, gap~~) |
| `delete_doc` | ✅ | — | ✅ | covered (~~was list-only, gap~~) |
| `star_docs` | ✅ ×3 | `roundSix` (mixed case) | ✅ | covered (~~was list-only, gap~~) |
| `list_starred` | ✅ | — | ✅ | covered (~~was list-only, gap~~) |
| `list_projects` | ✅ | — | ✅ | covered (~~was list-only, gap~~) |
| `get_project` | ✅ ×2 | — | ✅ | covered (~~was list-only, gap~~) |
| `update_project` | ✅ ×4 | — | ✅ | covered (~~was untested~~) |
| `remove_doc_from_project` | ✅ ×2 | — | ✅ | covered (~~was untested~~) |
| `tag` | ✅ | — | ✅ | covered (~~was absent~~) |
| `untag` | ✅ | `roundSix` (spelling, folding) | ✅ | covered (~~was absent~~) |
| `list_tags` | ✅ | — | ✅ | covered (~~was absent~~) |
| `list_revisions` | ✅ ×2 | — | ✅ | covered (added 2026-09-24) |
| `get_revision` | ✅ ×3 | — | ✅ | covered (added 2026-09-24) |
| `revision_contributors` | ✅ | — | ✅ | covered (added 2026-09-24) |

**As of 2026-09-25 no tool is outside the harness.** What follows is the state on 2026-09-21, kept
because it explains why the two writes below got the most steps when they were added.

*Eleven of thirty-three tools were in no automated harness.* Nine of them had been driven by hand
in a sweep, which is worth nothing tomorrow. Two had never been called by anything but their own
registration:

- **`update_project`** — renames a project and toggles its public page. The public-page switch
  turns a live `/p/<shareId>` on and off for every recipient holding it.
- **`remove_doc_from_project`** — takes a document out of a room. Recipients of the room's links
  lose access to that document; recipients of the document's own links do not.

Both are writes. Both change what a recipient can open. Neither has ever been asserted.

The three tag tools are absent from `e2e.ts` entirely, not merely unasserted: they shipped in
`31b296b` after the harness was written and were never added to it.

### What the matrix cannot tell you

`e2e` in the table means "invoked, with assertions on what the step cared about". It is not field
coverage. `get_share` returns twenty-two keys and the harness checks a handful. Of the eleven
round-six defects, three were in fields that did not exist yet (`downloadsEnabled`, `atLimit`,
`unchangedFromPrevious` — the dropped-field class) and the rest were in fields the harness either
never reads or reads without asserting. A tool marked covered can still be wrong in a field nothing
looks at, which is precisely how every sweep after the second one found anything.

---

## 3. The unit tests, and what each is really for

| File | Tests | Guards |
|---|---|---|
| `mcpConfirm.test.ts` | 6 | `requireHumanConfirmation` — elicitation, a dismissed prompt being distinct from a decline, severity wording |
| `mcpIdempotency.test.ts` | 6 | `IdempotencyStore.run`: replay, the fingerprint-mismatch refusal, the `stillExists` check |
| `mcpInstructionsBudget.test.ts` | 4 | `SERVER_INSTRUCTIONS` fits the 2,048 chars clients truncate at (it is 1,397) |
| `mcpOptimizePdf.test.ts` | 13 | Ghostscript presets, the size floor, the no-Ghostscript path |
| `mcpResolvePdfSource.test.ts` | 24 | `sourceUrl`/`filePath`/`fileBase64` exclusivity, the `data:` URI decode, `isLocalApiUrl` octet parsing |
| `mcpServerName.test.ts` | 3 | Connection naming (`lnkdrp`, `lnkdrp-usavx`) |
| `mcpSkipConfirmations.test.ts` | 7 | `LNKDRP_SKIP_CONFIRMATIONS` applies against a dev database and only there |
| `mcpWorkspaceLabel.test.ts` | 7 | `withWorkspace` on successes and errors; workspace named in instructions |
| `mcpRoundSixFixes.test.ts` | 7 | The 2026-09-20 regressions; each was checked by reverting its fix and confirming the test fails |

Only `mcpRoundSixFixes.test.ts` tests tool *answers*. The other eight test the machinery underneath
them. That asymmetry is the coverage story in one line: the plumbing is tested, the replies are not.

---

## 4. The six sweeps

Reconstructed from the commit history, which is the only durable record. Each sweep was a manual
fan-out against a live server, and the fixes landed same-day.

| Day | Commits to `mcp/src` | What that day's sweep was looking for |
|---|---|---|
| 09-15 | 11 | First pass after launch: plan limits, per-audience links, owner-vs-recipient views |
| 09-16 | 10 | Upload path — optimization presets, base64, local files, failure reporting |
| 09-17 | 30 | The broadest day: passwords, confirmations, project tools, star tools, idempotency, activity types |
| 09-18 | 16 | Tags shipped and were swept immediately; archived-document behaviour; refusal wording |
| 09-19 | 13 | Untrusted content, search narrowing, the dropped-field class |
| 09-20 | 14 | Two rounds: shape parity and internal-fault mapping, then the eleven in `305baf9`/`a7f2e41` |

Three findings from those sweeps are worth carrying forward as *classes*, because each recurred
after being fixed once:

1. **Dropped fields.** The API client whitelists response fields, so any field a route adds is
   invisible until someone maps it. This produced `projectLinkTraffic`, `totalsAllTime`,
   `downloadsEnabled`, `graceActive`/`atLimit`, and `unchangedFromPrevious` — five separate
   incidents of the same mechanism, each one a tool answering a question with data it never saw.
2. **Case-sensitive id compares.** `docIdSchema` accepts either case; the API normalises; every
   in-tool compare is a string equality. Hit `list_docs` (`ae60110`) and then `star_docs`
   (`305baf9`) in exactly the same way, four days apart.
3. **A commit claiming more than it delivered.** Three commits on 09-19 asserted fixes that were
   not in the diff (`4329eca` cleaned them up). Found only because a critic agent re-read the
   claims against the code.

Nothing automated catches any of the three. The dropped-field class is the one worth a real guard —
see section 6.

---

## 5. Standing known issues

Carried from `docs/CHANGELOG-2026-09-20.md`; unchanged as of 2026-09-21.

- **Cloud connectors cannot authenticate.** `authorization_servers` is empty, so a client that
  authenticates on the user's behalf has nowhere to send them. Header-auth clients work. OAuth is
  scoped in `docs/prds/lnkdrp-mcp-oauth.md` and deliberately not built.
- **One machine only.** Sessions live in memory, so the Fly app is pinned to a single instance:
  every deploy drops connected agents, and the 24h idempotency cache is per-process — a retry after
  a restart creates a duplicate rather than replaying.
- **Thirty orphaned test tags** in USAVX, all with a count of zero. `DELETE /api/tags/:id` refuses
  API keys, so removing them needs a signed-in human on `/tags`. Every sweep that touches tagging
  adds a few more.
- **Six product surfaces have no MCP tool at all**: version history, workspace metrics, project
  analytics, project-link passwords, member and invite management, billing detail. Nothing
  announces them: `whoami.capabilities.notMcpAccessible` names `requestRepos` and
  `downloadAccessRequests`, and has never held any of these six, so an agent meets their absence
  only as a tool missing from `listTools`. This bullet used to claim the six were reported in that
  field. They never were, on any commit, and the sentence was not in the changelog it says it
  carries; a reader who called `whoami` to find the warning about, say, workspace metrics got two
  unrelated entries and had to guess whether the field or this document was broken.
- **Nothing checks the Docker image's `COPY` list** against what `mcp/src` imports out of
  `src/lib`. A new import compiles locally and breaks the image.

---

## 6. What to do next, in order

1. **Add the eleven uncovered tools to `tests/mcp/e2e.ts`.** The harness already creates a
   throwaway document and a throwaway project, so archive/delete/star/tag/project-read steps slot
   into the existing lifecycle with no new fixtures. `update_project` and
   `remove_doc_from_project` first: they are writes that change recipient access and have never
   been asserted.
2. **Guard the dropped-field class.** A test that reads a route's response keys and fails when the
   API client's mapper does not carry a field it has been told to expect. Five incidents of one
   mechanism justifies a mechanism-level guard; the alternative is finding the sixth by hand.
3. **Assert shape parity where a tool has two branches.** `get_share` by `docId` versus by a
   non-default `shareId` returned different key sets twice (`2866dd5`, `f82c944`). One test
   comparing the two key sets would have caught both.
4. **Leave the manual sweeps behind a reason.** Six sweeps found ~124 defects, but the last one
   found eleven, mostly low-severity, and most of the day's value was in the fixes rather than the
   discovery. Run the next one when a surface changes, not on a schedule.

Filed in metis as **M6 — MCP test coverage** (`ms_0XlawGRCzr`) under `prd_thRjwCQvKg`:

| Task | Item |
|---|---|
| `mt_TVjIKfmZWj` | `update_project` and `remove_doc_from_project` are called by nothing (bug) |
| `mt_FWTDf6Rlpe` | Add the nine hand-probed-only tools to `e2e.ts` |
| `mt_jKJ7MiEcxJ` | Guard the dropped-field class |
| `mt_gyPQSZep-T` | Assert shape parity on the two-branch tools |

Item 4 is a judgement call, not a task: nothing to build, just a decision not to run sweep seven
until a surface changes.
