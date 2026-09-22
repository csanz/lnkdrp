# PRD — Production readiness: the gap between the branch and the live site

**Status:** Draft (v1)
**Owner:** chrissanz
**Last updated:** 2026-09-22
**Project:** lnkdrp
**Sibling docs:** [lnkdrp-view-notifications](./lnkdrp-view-notifications.md) · [lnkdrp-notification-queue](./lnkdrp-notification-queue.md) · [lnkdrp-plan-limits](./lnkdrp-plan-limits.md) · [DEPLOY](../../DEPLOY.md)

> **Decision (2026-09-22).** `fix/production-readiness` is 59 commits ahead of `origin/main`, written
> by three concurrent sessions sharing one working tree. Production still serves `dc0ed14`. The
> merge is not the first task — it is the last one, after the defects a pre-merge review found are
> closed and the two red suites are green.

---

## Problem

The live site is a day and 59 commits behind the branch, and nobody can tell from inside any one
session what the merge would do. Three Claude sessions edited the same tree concurrently; a
pre-merge review (24 agents, 10 confirmed findings, 7 refuted) found defects that were invisible
from within the sessions that caused them — a session running `tests:lib:vitest` sees green while
`tests:credits:vitest` is red, because the contract changed in one suite and not the other.

Two consequences are already live-facing. `/` is ungated in production, so the early-access queue
stops nobody. And local development mails real people: four hard bounces to seeded `@*.example`
recipients landed against `updates.lnkdrp.com` on the day its DMARC record went up.

## Goal

Get `fix/production-readiness` to a state where merging it is a decision about timing rather than
about risk: no confirmed blockers, both test suites green, and the config production needs actually
set in Vercel before the deploy rather than discovered by it.

## Proposed decisions (to lock)

1. **The merge is gated on the review, not on the calendar.** M1 and M2 close before M5.
2. **Notification preferences stay per workspace.** A workspace can be a different company; a
   global switch would be wrong. The one-click unsubscribe is per membership for the same reason.
3. **Transactional email gets no off switch.** Suppressing "you were removed" or "new documents are
   paused" leaves somebody locked out with no idea why. The Notifications page lists them instead,
   each saying why it cannot be turned off.
4. **A teammate's *new* document is a different event from a *replacement*.** It needs its own queue
   kind, its own preference and its own off-token purpose rather than riding on `doc_updates`.
5. **Nobody is emailed about their own upload.** Open question on `doc_updates`, which currently
   enqueues for every member including the one who did the replacement.

## Approach

Close the confirmed findings first, hardest first, then the correctness work in the crons, then the
new notification, then merge. Each milestone ends with both suites green and the work committed with
a pathspec — the tree is shared, so `git add -A` sweeps up other sessions' files.

## Non-goals (v1)

- Deep-linking the history page to a specific version. "See what changed" lands on the history for
  now; the page takes no version from the URL.
- A weekly digest. Only daily exists and nothing has asked for weekly.
- `repo_link_request` UX beyond parity — it is behind a flag and nobody sees it.
- Tightening DMARC past `p=none`. That waits for a few weeks of aggregate reports.

## Milestones

### M1 — Close the confirmed pre-merge findings

- Fix the ignored "Compare every replacement" switch; the workspace is billed for a comparison it turned off (BLOCKER, process/route.ts:2030)
- Update tests/credits/planLimits.test.ts for checkLimit's used/requested contract; 7 tests are red at HEAD
- Correct upsellCopy.ts, which still states the old Free caps of 3 documents, 1 project, 300 credits
- Commit or remove src/components/home/ProductShots.tsx, untracked but imported by committed code, which breaks a clean checkout
- Fix tests/lib/adminOverviewTempUsers.test.ts, red in the full run
- Make tests/lib/waitlistGate.test.ts pass in the full suite, not only in isolation; its cache state leaks across files

### M2 — Correctness in the jobs that run every five minutes

- Fix the batch truncation in stripe-credits-report
- Fix the `changed` gate in both reconcilers
- Report errors from notification-emails instead of swallowing them
- Fix the plan-limits cursor
- Make --dry-run honest in the routes where it is not; notification-emails is already honest, verify each of the others
- Replace seeded @*.example recipients with a domain we control and no MX, so local runs cannot hard-bounce the sending domain

### M3 — Notify members when a teammate uploads a new document

- Add the doc_uploads queue kind, cursor key and dedupe
- Add docUploadEmailMode to OrgMembership with its runtime schema patch
- Enqueue on the !isReplacement branch of the upload processor, excluding the uploader
- Build a pure docUploadEmail builder with its own off-token purpose, modelled on docUpdateEmail.ts
- Add the third dropdown, its ? explainer, and the catalogue and EMAIL_COPY entries
- Decide whether doc_updates should stop emailing the member who did the replacement

### M4 — Finish the email surface

- Convert repo_link_request.immediate and .daily to a pure builder with HTML and an unsubscribe
- Deep-link the history page to a version so "See what changed" lands on the comparison itself
- Test coverage for the paths the review found untested, worst-failure-first

### M5 — Merge and deploy

- Set WAITLIST_ENABLED in the Vercel production project
- Merge fix/production-readiness to main and watch the deploy
- Confirm / is gated in production and the queue actually holds a new signup
- Confirm the Stripe webhook fires with the corrected signing secret
- Rotate the Atlas password, which was pasted into a session transcript
- Deploy the realtime and MCP servers to Fly; neither app exists today

## Verification

- `npx tsc --noEmit`, `tests:lib:vitest` and `tests:credits:vitest` all clean before M5 starts.
- Run the notification cron with `--dry-run` twice and confirm the same rows stay claimable; that is
  what proves the dry run writes nothing.
- Render every email and look at it. Three defects in this work passed tsc and a green suite: a
  workspace name wrapping one letter per line, document titles listed twice, and a client component
  pulling mongoose into the browser. Only a screenshot caught them.
- After M5, `GET /api/health` reports the merged commit and `/` redirects a queued account.

## Future

- DMARC `p=none` → `p=quarantine` → `p=reject` once aggregate reports show only Resend and Google.
- A weekly digest, if anyone asks for one.
- Revocable unsubscribe tokens; today the expiry is the only bound on a leaked link.
