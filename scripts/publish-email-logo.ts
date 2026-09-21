/**
 * Put the email header logo on the blob CDN, at a fixed path.
 *
 * Emails cannot use `/public` the way pages do. A page resolves a relative path against whatever
 * host served it; an email is read in someone's mail client, where the only thing that works is an
 * absolute URL to something already public. That makes the site's own `public/` folder a poor home
 * for it: the asset would only start resolving on the next deploy, and every email sent in between
 * would carry a broken-image box.
 *
 * So the canonical copy lives in blob storage, which is live the moment this runs and independent
 * of deploys. `public/email-logo.png` stays in the repo as the source of truth for what was
 * uploaded.
 *
 * Re-run after changing the logo:
 *   npx tsx --env-file=.env.local scripts/publish-email-logo.ts
 *
 * Then put the URL it prints in `EMAIL_LOGO_URL`, or update the default in `lib/email/layout.ts`.
 */
import fs from "node:fs";
import { put } from "@vercel/blob";

async function main() {
  const bytes = fs.readFileSync("public/email-logo.png");
  const res = await put("brand/email-logo.png", bytes, {
    access: "public",
    contentType: "image/png",
    /**
     * A fixed path, never a random suffix.
     *
     * This URL is baked into every email we have already sent, and those keep being opened for
     * years. A new path per upload would leave a trail of dead images in old inboxes, so the
     * upload overwrites in place instead.
     */
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 31536000,
  });
  console.log(res.url);
}

void main();
