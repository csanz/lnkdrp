# PRD — Link access: verified email and allow lists

**Status:** **Deferred 2026-09-18 by the owner, the same day it was drafted: password protection
stays the only access control for now.** Nothing here is built and nothing is scheduled. The
document is kept because the problem it describes has not gone away — a URL still travels, and a
password still forwards with it — and because the two corrections it makes to
[lnkdrp-enterprise](./lnkdrp-enterprise.md) hold whenever this is picked up. Drafted 2026-09-18.
Supersedes the "verified access" bullet in
[lnkdrp-enterprise](./lnkdrp-enterprise.md) M3 (see "Corrections to existing PRDs") and fills
[lnkdrp-multi-links](./lnkdrp-multi-links.md) M4.
**Owner:** chrissanz
**Last updated:** 2026-09-18
**Project:** lnkdrp
**Sibling docs:** [lnkdrp-multi-links](./lnkdrp-multi-links.md) · [lnkdrp-project-links](./lnkdrp-project-links.md) · [lnkdrp-enterprise](./lnkdrp-enterprise.md) · [lnkdrp-plan-limits](./lnkdrp-plan-limits.md) · [METRICS](../METRICS.md)

---

> **Read this first if you are picking it up.** The decisions below were written to be locked,
> not to be re-argued, but none of them was ever exercised against real code. Treat decisions 1, 2
> and 7 (where the fields live, why the enum is not a ladder, and Pro vs Enterprise) as the
> durable part; treat the limits in decision 8 and the flow diagram as a starting point to be
> re-checked against whatever the gate looks like by then.

## Problem

A share link is a URL, and a URL travels. Today a sender has exactly two controls over who can
open one: they can put a password on it, or they can not.

Both fail the same way. A password is a second thing to forward — it arrives in the same email
thread as the link, and one "looping in Dave" forwards both. Neither control produces a record
of *who* was on the other end: the password gate knows a password was correct, not who typed it.
The product's answer to "who read this" is "Introduce yourself", which is voluntary, typed, and
unverified — a recipient can be anyone they like, and an uninterested one is simply nobody.

For the case the product is increasingly used for — a data room sent to investors, a diligence
packet, a defence one-pager — that is not enough:

- **The sender cannot prove access.** "Who saw the Q3 numbers" is answered by a list of browser
  fingerprints with self-reported names attached. In a diligence context that list is an
  artefact someone may later have to stand behind.
- **The sender cannot scope access.** There is no way to say "this link is for Sequoia" and have
  the link mean it. The nearest thing is a per-recipient link, which is real and useful
  (multi-links M3) but relies on the recipient not forwarding it.
- **A forward is invisible.** When a link does travel beyond its audience, nothing says so. The
  view lands in the feed as one more anonymous reader.

The missing primitive is not "make people log in". It is **the link knows who it is for, and can
tell whether the person holding it is one of them.**

## Goal

A sender can say who a link is for, and that link enforces it — without the recipient creating
an account, and without the sender leaving the page they created the link on.

Every view that gets through carries an email address the product verified, so "who read this"
is answerable with something firmer than a typed name, and every view that is refused is visible
to the sender, because a refusal is usually the most interesting thing that happened that week.

## Non-goals (v1)

- **Sign-in as the gate.** The only provider wired up is Google (`docs/FEATURES.md`,
  Authentication). Requiring sign-in would mean requiring a Google account, which excludes most
  corporate, Microsoft 365 and government recipients — exactly the audience a restricted link is
  sent to. A Google login also proves *an* account, not *the* person: anyone can make one with
  any name. Verified email is strictly better on both counts and lands on every recipient.
- **SSO / SAML / OIDC.** Genuinely Enterprise-shaped work (per-workspace identity provider
  configuration, domain routing, member provisioning). Stays in
  [lnkdrp-enterprise](./lnkdrp-enterprise.md) M3, and is the only part of "verified access" that
  should live there — see the corrections below.
- **Per-document access inside a data room.** Access is a property of the link, and a project
  link is one link for the whole room. A sender who needs two audiences with different file
  access makes two rooms, or two document links. Listed under Future.
- **Stopping a recipient sharing what they read.** An allow list controls who can open the link.
  It does not control screenshots, downloads (that is `allowDownload`), or someone reading the
  deck aloud over a call. No watermarking, no DRM, no "view only" claims we cannot keep.
- **Blocking disposable-address providers.** Tempting and wrong: the blocklist is never current,
  and a sender who has named the addresses they expect has already solved the problem better.
- **Recipient accounts, profiles or a viewer-side inbox.** A verified recipient stays a
  recipient.

## Proposed decisions (to lock)

### 1. Access lives on the link, not the document

`ShareLink` gains the fields; `Doc` gains nothing. This is the rule multi-links already
established and that the viewer route comments state outright — *"Permissions belong to the link,
not the document: two recipients of the same deck can have different download rights"*
(`src/app/s/[shareId]/page.tsx`). Access is the same kind of property as `allowDownload`,
`expiresAt` and the password, all of which are per link.

This corrects the shape proposed in [lnkdrp-enterprise](./lnkdrp-enterprise.md) M3
(`Doc.shareAccess`), which predates multi-links. Because it is on `ShareLink`, project links get
it for free: one row, one gate, covering `/p/:shareId` and every document inside it.

### 2. Two orthogonal fields, not one ladder

The Enterprise draft proposed a single level enum,
`"link" | "password" | "verified_email" | "allowlist" | "sso"`. That conflates things that
compose. A sender can reasonably want a password *and* an allow list; "allowlist" without
verification is not a stronger level than "verified_email", it is meaningless, because an
unverified address can be typed by anyone.

```ts
// ShareLink
access: { type: String, enum: ["open", "verified_email"], default: "open", index: true },
/** Only meaningful when access is "verified_email". Empty = any address that verifies. */
allowlist: [{ type: String, trim: true, lowercase: true }],
```

- `open` — today's behaviour. Every existing link is this, with no migration.
- `verified_email` — the recipient gives an address and proves they can read it before the
  document renders.
- `allowlist` — addresses (`roelof@sequoiacap.com`) and domains (`@sequoiacap.com`). A non-empty
  allow list **implies** `verified_email` and is rejected on an `open` link at the API boundary,
  because an allow list you can lie your way past is a UI that lies to the sender.

The existing password stays exactly as it is, and composes. Password then email, in that order:
the password is the cheaper check and costs no outbound mail.

### 3. Verification is a six-digit code to that address. No account, no magic link.

The recipient types an address, receives a code, types it back. Nothing is created for them.

Not a magic link: a magic link opens in whatever browser the mail client hands it to, which is
routinely a different browser (or an in-app webview) from the one holding the URL — so the
recipient lands on a page with no link context, and the verification cookie is set on a browser
that is not the one reading. A code is typed into the tab that is already open, which is the tab
that needs the cookie. It also survives a corporate mail gateway that rewrites or pre-fetches
links, which silently burns single-use magic links.

- Code: 6 digits, ten-minute TTL, at most 5 attempts, single use, stored hashed.
- On success: a signed cookie per `shareId`, exactly like the password cookie
  (`shareAuthCookieName(shareId)`, `path: "/"`, so it covers `/p/:shareId/:docId`, the PDF proxy
  and `/api/share/:shareId/*`). Contents: the verified address plus an HMAC over
  `shareId + email` with the server secret, so the ingest can *read* the address and trust it.
- Lifetime: 30 days, longer than the password cookie's 14, because re-verification costs an
  email rather than a re-read of the original message.

### 4. An allow list is checked before an email is sent, and says so

The gate refuses a non-listed address without sending anything, and tells the person plainly
that the link is open to specific people and to ask the sender.

This leaks whether a guessed address is on one sender's list, and that is the right trade. The
alternative — send a code to any address, refuse after — makes the product an open relay that
emails arbitrary strangers on behalf of anyone holding a URL, which is both an abuse vector and
a deliverability risk to every other email we send. The enumeration risk is bounded: the attacker
must already hold the link, learns only membership of that one list, and is rate-limited (below).
A refused recipient who *is* meant to be there needs to know what happened, or the sender gets a
confused reply instead of a fix.

### 5. Refusals are events, and the most valuable ones in the feed

- `share.access_denied` — someone gave an address that is not on the list. This is the product
  telling a sender their link was forwarded, which nothing has ever been able to tell them. Meta
  carries the attempted address (Pro-gated with every other recipient identity), the link and the
  project.
- `share.unlocked` gains `meta.method: "password" | "email"`, rather than a second type. Both
  mean "a recipient got through the gate"; only the mechanism differs.

`share.access_denied` joins `RECIPIENT_TYPES` in `src/app/api/activity/route.ts`, which is the
one set that governs identity gating and the late-name join for recipient rows.

A denial is also the first candidate for its own notification email — an owner who learns on
Friday that their data room was forwarded on Tuesday has learned it too late. Deliberately left
to M3 behind the existing `notification-emails` cron rather than bolted on here.

### 6. Verified identity outranks typed identity, everywhere

A verified address is written to `ShareView.viewerEmailSnapshot` and
`ProjectLinkView.viewerEmailSnapshot` with a new `viewerEmailVerified: true`, and:

- **"Introduce yourself" is not shown** to a recipient who has already verified. Asking someone
  to introduce themselves thirty seconds after they proved who they are reads as the product not
  paying attention. The existing "Viewing as …" affordance shows the verified address instead,
  with no Clear action — they cannot un-verify without losing access.
- **`propagateViewerIdentity` never overwrites a verified address with a typed one.** The
  function already refuses to write over an account-backed identity
  (`src/lib/share/viewerIdentity.ts`); verified addresses join that rule.
- **The metrics pages mark it.** A verified row gets a quiet badge; a typed one does not. The
  distinction is the entire point of the feature and must survive into the surface the sender
  reads.

### 7. Pro, not Enterprise — and a downgrade never opens a closed link

**Pro.** Verified email and allow lists are the table stakes of the category (DocSend and
Papermark both gate on email at their paid tiers) and the feature that makes lnkdrp usable for
the data-room job it is already being used for. Behind "Talk to us" it would convert nobody and
would leave the self-serve product with password-or-nothing. Free keeps `open` and `password`.

**On downgrade, a restricted link keeps enforcing its restriction.** It does not quietly become
`open`. A plan change is a billing event; silently publishing a link that a sender restricted
would be a security incident caused by an invoice. The sender can still *loosen* access on Free
(that is their decision, made deliberately); they cannot tighten or edit the list until they
upgrade. The links page says which links are held that way and why.

This is the same shape as the existing rule that real downloads stay visible after downloads are
turned off: the product never rewrites history or silently widens access to reflect a plan.

### 8. Rate limits, in one place

The gate is an unauthenticated endpoint that can cause outbound email, so:

| Bucket | Limit |
|---|---|
| Codes requested per IP | 10 / 15 min |
| Codes requested per (link, address) | 3 / hour |
| **Distinct addresses** per link, no allow list | 20 / hour |
| Code attempts per (link, address) | 5, then the code dies |
| Denied attempts per IP per link | 10 / hour, then the gate stops answering |

The third row is the one that matters and has no analogue today: without it, a link with
`verified_email` and no allow list lets anyone holding the URL make us email twenty thousand
strangers. All of it goes through the existing `rateLimit` helper, beside the unlock route's
limiter.

### 9. Agents can set it, and loosening it asks a human

`lnkdrp_create_share_link` and `lnkdrp_update_share_link` gain `access` and `allowlist` — an
agent asked to "share the data room with the Sequoia team" should be able to do the whole job.

**Tightening is silent; loosening confirms.** Removing addresses, emptying the list or setting
`access: "open"` on a restricted link goes through the same elicitation the destructive tools use
(`docs/MCP.md`, and the confirmation rules in the MCP PRD): an agent that widens who can read a
data room has done something the owner needs to have agreed to. A dismissed prompt is final; a
headless agent cannot loosen access at all.

### 10. The owning side never sees the gate

A signed-in member of the workspace that owns the link goes straight through, resolved by
`isOwnerSideViewer` — the same rule that flags their views `isOwnerPreview` and keeps them out of
every figure. An owner who has to email themselves a code to check their own link will assume
the feature is broken.

## Recipient flow

```
        ┌──────────────────────────────┐
        │  /p/:shareId  or  /s/:shareId │
        └──────────────┬───────────────┘
                       │
        owning side? ──┴── yes ──▶ straight through (no gate, view not counted)
                       │
                       no
                       │
        password set? ─┴── yes ──▶ [password gate]  (unchanged)
                       │
        access ────────┴── open ──▶ document
                       │
                 verified_email
                       │
            ┌──────────┴───────────┐
            │  cookie already      │ yes ──▶ document
            │  verified for this   │
            │  shareId?            │
            └──────────┬───────────┘
                       no
                       │
            ┌──────────┴───────────┐
            │ "Who is this for?"   │
            │  email input         │
            └──────────┬───────────┘
                       │
          allow list ──┴── no match ──▶ refused, plainly, nothing sent
                       │                └─▶ share.access_denied
                     match
                       │
              code emailed ──▶ 6-digit input ──▶ cookie set ──▶ document
                                                      └─▶ share.unlocked (method: "email")
```

The gate is the existing `PasswordGate` surface, which already carries the sender's workspace
mark (`ShareWorkspaceBrand`) — and needs to here more than anywhere: a page asking for your email
address, unsigned, is indistinguishable from a phishing page.

## Sender UI

On the link row (`LinksManager`) and in the create-link flow, one control with three states —
**Anyone with the link · Password · Verified email** — and, under the third, an address box that
accepts a pasted list, one per line or comma-separated, normalising `sequoiacap.com` and
`@sequoiacap.com` to the same domain rule. Pasting a forwarded "To:" header should Just Work.

The links table gains a column showing the state at a glance, and each link's metrics page shows
its allow list with, beside each entry, whether that person has verified yet. That last column is
the one a sender will actually use: it is a read receipt for the audience, not for the document.

## Milestones

### M1 — Verified email
`ShareLink.access`, the gate UI on `/s` and `/p`, code issue + verify endpoints, the signed
cookie, `share.unlocked` with `method`, verified identity on `ShareView` / `ProjectLinkView`,
"Introduce yourself" suppressed when verified, rate limits, Pro gate + downgrade rule.

### M2 — Allow lists
`ShareLink.allowlist`, address and domain matching, the refusal path and `share.access_denied`,
the sender UI including paste-a-list, the verified/not-yet column on the link's metrics page.

### M3 — Reach and reporting
MCP `access`/`allowlist` with the loosening confirmation; a denial notification email through the
existing `notification-emails` cron (immediate and digest, following each member's `viewEmailMode`);
"access log" export for a link (CSV: address, verified at, first open, last open, pages).

## Open questions

1. **Is a verification per link, or per workspace?** Per link is stricter and is what this PRD
   assumes. Per workspace ("you verified with this sender last week") is materially kinder to a
   recipient working through a data room's twelve documents, and is what most incumbents do.
   Recommendation: per link for M1, revisit with real usage — widening later is easy, narrowing
   later breaks sessions.
2. **What happens to a reader who is mid-document when the sender adds an allow list that
   excludes them?** Their cookie is still valid. Options: let it ride to expiry (simplest,
   arguably wrong), or stamp the link with an `accessChangedAt` that invalidates cookies issued
   before it (correct, one extra field, and makes "revoke now" mean something).
   Recommendation: the second — a sender who restricts a link expects it to be restricted now.
3. **Should `verified_email` with an empty allow list be offered at all?** It is "tell me who you
   are before you read this", which is a real and popular product (it is most of what DocSend
   sells), but it is also the configuration with the outbound-email abuse surface of decision 8.
   Recommendation: ship it, with the per-link distinct-address cap, because without it every
   sender must know their audience's addresses in advance — which the data-room-sent-to-a-firm
   case rarely allows.
4. **Plus-addressing and Gmail dots.** `roelof+deck@` reaches the same mailbox as `roelof@`, so
   stripping the tag for matching is user-friendly and not a hole. Gmail's dot-insensitivity is
   the same argument but provider-specific. Recommendation: strip `+tag` for comparison, leave
   dots alone, store the address as given.

## Corrections to existing PRDs

Both in [lnkdrp-enterprise](./lnkdrp-enterprise.md) M3, which was written before multi-links
shipped:

1. **`Doc.shareAccess` becomes `ShareLink.access` + `ShareLink.allowlist`** (decision 1). Access
   is per link, like every other permission.
2. **"Verified access for sensitive links" moves from the Enterprise card to Pro** (decision 7).
   The Enterprise pricing card copy needs to change — the enterprise-shaped half is SSO, so the
   card should say *"Single sign-on for sensitive links"* and the Pro tier should name verified
   access. `BillingConfig` copy and `/pricing` both carry that string.

The MCP tool named there, `lnkdrp_set_share_access`, is not needed: `lnkdrp_update_share_link`
already exists and takes the link's other permissions (decision 9).

## Future

- Per-document access inside a project (an allow list on the room plus a tighter one on the
  term sheet).
- SSO as a third `access` value, delegating to the Enterprise identity work.
- Device or session binding for a verified address (one open session per address at a time).
- A click-through NDA before the code step, which is the next thing a diligence sender asks for
  after this ships.
- Recipient-side "links shared with me", once a meaningful number of people have verified the
  same address across several senders.
