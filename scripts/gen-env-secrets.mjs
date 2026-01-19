#!/usr/bin/env node
/**
 * Generate production-ready secrets for env vars.
 *
 * Usage:
 *   node scripts/gen-env-secrets.mjs
 *
 * Notes:
 * - Prints `KEY="value"` lines for easy copy/paste into Vercel.
 * - Uses base64url so the output is URL/JSON friendly (no + or /).
 */
import crypto from "node:crypto";

function b64url(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

const vars = [
  // Required secrets
  ["NEXTAUTH_SECRET", b64url(32)],
  ["LNKDRP_CRON_SECRET", b64url(32)],

  // Recommended app-specific secrets (used for token/password flows)
  ["LNKDRP_SHARE_PASSWORD_SECRET", b64url(32)],
  ["LNKDRP_ORG_INVITE_TOKEN_SECRET", b64url(32)],
];

for (const [k, v] of vars) {
  // Quote values for easy copy/paste.
  console.log(`${k}="${v}"`);
}

