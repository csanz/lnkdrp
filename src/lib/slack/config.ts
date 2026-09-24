/**
 * The Slack app this deployment installs from, read from the environment.
 *
 * `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` are the app's credentials from api.slack.com. With
 * either missing the integration is not offered: the Integrations page says so and the install
 * route answers 503. `LNKDRP_SLACK_SECRET` (optional) is the encryption and signing master, see
 * `crypto.ts`.
 *
 * The redirect URL Slack sends the user back to is built from the configured site URL, never
 * from the request's host header, so a spoofed host cannot redirect an install elsewhere. It
 * must match one of the redirect URLs registered on the Slack app exactly, including the scheme:
 * Slack requires https, which is why local development goes through a tunnel (docs/DEV.md).
 */
import { resolveConfiguredSiteUrl } from "@/lib/urls";

export const SLACK_OAUTH_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
export const SLACK_OAUTH_ACCESS_URL = "https://slack.com/api/oauth.v2.access";
export const SLACK_AUTH_REVOKE_URL = "https://slack.com/api/auth.revoke";
export const SLACK_SCOPE = "incoming-webhook";
export const SLACK_CALLBACK_PATH = "/api/slack/oauth/callback";

export type SlackAppConfig = { clientId: string; clientSecret: string };

export function slackAppConfig(): SlackAppConfig | null {
  const clientId = (process.env.SLACK_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.SLACK_CLIENT_SECRET ?? "").trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function slackEnabled(): boolean {
  return slackAppConfig() !== null;
}

/** The absolute callback URL, or `null` when no site URL is configured. */
export function slackRedirectUri(): string | null {
  const site = resolveConfiguredSiteUrl();
  if (site) return `${site.origin}${SLACK_CALLBACK_PATH}`;
  if (process.env.NODE_ENV !== "production") return `http://localhost:3001${SLACK_CALLBACK_PATH}`;
  return null;
}
