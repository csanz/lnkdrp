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

## Activation: as the LLC, which means waiting for it

**Decision (2026-09-21): Stripe is activated as the Company, not as a sole proprietor.** The whole
point of forming the LLC was to be the entity behind the payments, and activating as an individual
would have meant converting later — cheap at a handful of customers, unpleasant past that.

The cost of that decision is a few days with no payments, because the sequence cannot be shortened:

1. California files the LLC. LegalZoom has the *order*; the stamped Articles of Organization take
   days. Nothing downstream can start before this.
2. **EIN** at irs.gov — free, instant, about ten minutes. Do not pay anyone for it. Needs the LLC
   to exist first.
3. Business bank account (Mercury or similar). Needs the EIN and the Articles.
4. **Then** activate Stripe, business type **Company**, with the LLC's legal name, EIN and address.

There is no way to enter a company into Stripe without a tax id, so there is no version of this
that runs in parallel. If payments become more urgent than the entity, the fallback is to activate
as an individual and convert once the Articles land — do it while the customer count is small,
because Stripe sometimes moves a large account to a *new* account rather than converting it, and
migrating live subscriptions and saved cards is support-assisted and worth avoiding.

Either way the statement descriptor is `LNKDRP` from the start, so nothing customer-visible changes
if a conversion does happen.

## Which address goes where

Stripe asks for addresses in two places and they are not the same address.

| field | use | why |
|---|---|---|
| Personal / identity | the **home address** | Stripe verifies identity against public records; a mailbox will stall or fail it |
| Business address | the **PMB** (`455 Market St Ste 1940 PMB 695619, San Francisco CA 94105`) | it is what becomes public, and it is the entity's address of record |

The business address is a PMB (private mailbox, a CMRA in USPS terms). Stripe and banks sometimes
flag those for extra review, because they are also what someone hiding a location would use. It is
not a rejection and usually costs a day; if activation stalls with nothing else obviously wrong,
switching the business address to the home address clears it.

## Corrections to DEPLOY 4.2

- **The webhook URL is `https://www.lnkdrp.com/api/stripe/webhook`**, not the apex. `lnkdrp.com`
  308-redirects to `www`, and webhook POSTs do not reliably follow redirects. The runbook's apex
  URL predates the decision to make `www` canonical.

## What the entity does not do

The realistic bad day for this product is a customer's confidential document leaking, and an LLC
limits *whose* assets are exposed — it does not pay the claim. Tech E&O / cyber insurance is the
instrument for that, and it is still outstanding.
