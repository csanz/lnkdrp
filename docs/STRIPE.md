# Stripe: the account, the entity, and which world you are in

Who Stripe thinks we are, and why the answer has two versions right now. The *mechanics* of
subscriptions live in `docs/SUBSCRIPTION.md` (flow, webhooks, credits, catalog ids) and the live
setup checklist is `DEPLOY.md` section 4.2. This file is the part neither of those covers: the
legal entity, the account hierarchy, and the conversion that is still outstanding.

No keys, ids or secrets here. Sandbox catalog ids are in `docs/SUBSCRIPTION.md`; live values live
only in Vercel.

## The hierarchy, because Stripe renamed everything

```
Organization  "LinkDrop Org"          container for accounts; no money, no API keys
  └── Account  "Christian Sanz"       the merchant account: business details, bank, real money
        ├── LIVE                      real customers, real charges — needs activation
        └── Sandbox  "LinkDrop Sandbox"   isolated test world, its own everything
```

**Live and sandbox share nothing.** Not products, prices, meters, webhooks, customers or keys.
Everything built in the sandbox has to be built again in live; that is not a sync problem to solve,
it is how Stripe works. "Test mode" in the account menu is the older mechanism and is not what we
use — the sandbox is.

Development points at the sandbox. `/a/env` names the account it reached, which is the fastest way
to tell which world a deployment is actually in.

## The entity

| | |
|---|---|
| Legal entity | **LNKDRP TECHNOLOGIES LLC** — California, single-member |
| Formed via | LegalZoom, ordered 2026-09-21; state filing pending at the time of writing |
| Industry | **Software** (NAICS **511210**, Software Publishers) |
| Stated activity | "The LLC will develop, license, host, and support software and related technology services." |
| Public business name | **LinkDrop** |
| Statement descriptor | **LNKDRP** |
| Website | **https://www.lnkdrp.com** |

Keep the industry wording consistent across the LLC filing, Stripe and the bank. Three different
descriptions of the same business is a small but real source of review friction.

## The conversion that is still outstanding

Stripe was activated as an **individual / sole proprietor**, because the LLC did not exist yet and
taking payments could not wait for it. That is a deliberate, temporary state.

**When the Articles of Organization arrive:**

1. Get the **EIN** at irs.gov — free, instant, about ten minutes. Do not pay anyone for this.
2. Open the business bank account (Mercury or similar). It needs the EIN and the Articles.
3. In Stripe, change the business type to **Company** and submit the LLC's legal name, EIN and
   address. Payouts move to the business account.

**Do this while the customer count is small.** Changing business type on an account with a handful
of subscriptions is paperwork; Stripe sometimes wants a large account moved to a *new* account
instead, and migrating live subscriptions and saved cards between accounts is a support-assisted
process worth avoiding. The cost of this conversion grows with every paying customer, so it is not
a task to leave sitting.

Customers see nothing change except, possibly, the statement descriptor — which is why it is set
to `LNKDRP` rather than a personal name from the start.

## Corrections to DEPLOY 4.2

- **The webhook URL is `https://www.lnkdrp.com/api/stripe/webhook`**, not the apex. `lnkdrp.com`
  308-redirects to `www`, and webhook POSTs do not reliably follow redirects. The runbook's apex
  URL predates the decision to make `www` canonical.

## What the entity does not do

The realistic bad day for this product is a customer's confidential document leaking, and an LLC
limits *whose* assets are exposed — it does not pay the claim. Tech E&O / cyber insurance is the
instrument for that, and it is still outstanding.
