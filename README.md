# lnkdrp

This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

Every command in one place: [`COMMANDS.md`](COMMANDS.md).

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Vercel Blob: client uploads (browser → Blob)

Uploads use the “client upload” flow described in the Vercel docs ([Client Uploads](https://vercel.com/docs/vercel-blob/client-upload)):

- Route: `/api/blob/upload` (uses `handleUpload()` to mint short-lived client tokens)
- Requires `BLOB_READ_WRITE_TOKEN` in `.env.local`

## Stripe subscriptions and credit packs (Checkout + webhooks)

This repo uses **Stripe Checkout** for the Pro subscription and for one-time credit packs (`/credits`), and **webhooks** as the source of truth for both: Pro access and purchased credits are granted only when the webhook arrives, never on the redirect back from Checkout.

### Local webhook testing

1. Install the Stripe CLI.
2. Login:

```bash
stripe login
```

3. Forward webhooks to the app:

```bash
stripe listen --forward-to localhost:3001/api/stripe/webhook
```

4. Copy the printed signing secret (`whsec_…`) into `STRIPE_WEBHOOK_SECRET` in `.env.local`, then restart the dev server so it picks it up. Keep `stripe listen` running in its own terminal the whole time you test.
5. Ensure `.env.local` also has:
   - `STRIPE_SECRET_KEY`
   - `STRIPE_PRICE_ID`
   - `NEXT_PUBLIC_APP_URL` (e.g. `http://localhost:3001`)
6. Start the app and either click **Upgrade** in `/dashboard?tab=overview`, or buy a pack on `/credits`.
7. Pay with a Stripe test card (test keys only — nothing is charged):

   | Card number | Result |
   |---|---|
   | `4242 4242 4242 4242` | Succeeds |
   | `4000 0025 0000 3155` | Asks for 3D Secure authentication |
   | `4000 0000 0000 9995` | Declined, insufficient funds |

   Any future expiry (e.g. `12/34`), any 3-digit CVC, any ZIP.
8. Confirm the result after the webhook runs: `/billing/success` flips to **Pro active** for an upgrade, and `/credits` shows **N credits added** for a pack.

**If a payment succeeds but nothing changes**, the webhook is not reaching the app. Stripe cannot call `localhost` on its own, so without `stripe listen` forwarding (and a matching `STRIPE_WEBHOOK_SECRET`) the Checkout payment completes while Pro never activates and pack credits never arrive — `/credits` sits on "taking longer than usual" indefinitely. Check that `stripe listen` is still running and that the secret in `.env.local` is the one it printed this session.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.


https://console.cloud.google.com/auth/clients?project=linkdrop-481404

