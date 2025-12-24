This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

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

## Vercel Blob: test upload script

1. Ensure you have a `BLOB_READ_WRITE_TOKEN` in `.env.local`.
2. Run:

```bash
npm run blob:test
```

This uploads `public/sample/skycatch.jpg` and `public/sample/usavx.pdf` to Vercel Blob (as **public** blobs) and prints the resulting URLs.

## Vercel Blob: client uploads (browser → Blob)

This implements the “client upload” flow described in the Vercel docs ([Client Uploads](https://vercel.com/docs/vercel-blob/client-upload)):

- Page: `/test/client-upload` (with a redirect from `/client-upload`)
- Route: `/api/blob/upload` (uses `handleUpload()` to mint client tokens)

Run your dev server and open `/test/client-upload` to upload either a local file or the two bundled samples.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.


https://console.cloud.google.com/auth/clients?project=linkdrop-481404

