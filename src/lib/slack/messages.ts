/**
 * What LinkDrop says in Slack. Every message is Block Kit with a plain-text twin, one header
 * line, one context line, one link, and never a Slack mention (a reader's name is text).
 *
 * M1 ships the connection test. The four event messages (opened, brief, replaced, received)
 * come with M2 and take the same inputs as the email round builders, so the two channels cannot
 * disagree about what a workspace may see.
 */
import type { SlackMessage } from "./post";

/** Slack's mrkdwn treats these three as markup; escape them in anything a person typed. */
export function mrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function slackTestMessage(input: { workspaceName: string; channelName: string; appUrl: string }): SlackMessage {
  const text = `LinkDrop is connected to ${input.channelName} for ${input.workspaceName}. Opens, visit briefs, replaced documents and received files will show up here.`;
  return {
    text,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*LinkDrop is connected to ${mrkdwn(input.channelName)}* for ${mrkdwn(input.workspaceName)}.\nOpens, visit briefs, replaced documents and received files will show up here.`,
        },
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `Change what posts, or the channel, under <${input.appUrl}/integrations/slack|Integrations>.` }],
      },
    ],
  };
}
