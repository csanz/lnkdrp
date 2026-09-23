# Plain: workflows, Ari and auto-responses

The paste-ready half of `docs/SUPPORT.md`. Everything here is configured in Plain's UI; nothing
in the codebase depends on it. Written 2026-09-23 against Plain's templates gallery as it was
that day.

## 1. Auto-response (do this first)

Settings → Auto-responses → New. Name "First reply". Trigger: thread created (the only one).
Channels: untick Slack, Discord and API; keep Email and Chat. No conditions. The form has no
delay setting, so it sends at once. Done 2026-09-23; check the toggle in the list is on.

```
Thanks {{ customer.shortName }}, we've got it and someone will reply within a business day.
Your reference is {{ thread.ref }}.
```

## 2. Route chat to the agent

First: Plain AI must be on (`https://app.plain.com/~/ai`) and the agent created, or "Assign to
user" cannot find it. Then Workflows → New workflow, built by hand. Three blocks, nothing else:

1. **Start**: change the trigger from Manual to **Thread created**.
2. **If/else**: Support channel **IS** Chat. Leave Else empty.
3. **Assign to user** on the If branch: the agent.

Name it "Chat to <agent name>" and Publish. Do not use Sidekick for this: it built the billing
branch backwards twice and could not resolve the agent. The billing branch is gone on purpose;
the custom instructions below hand billing to a human.

Then Ari → Preferences: **Shadow mode** first. Send five test questions from the chat bubble
(how do share links work, what does Pro cost, why can't I see who opened my link, how do I
connect Claude Code, how do I delete my account). When the drafts read right, switch to **Live**.
Add the email channel to the routing rule a week later, once chat has proven it.

## 3. Agent custom instructions

Ari → Preferences → Custom instructions. Product facts live on lnkdrp.com/help (the sitemap
knowledge source), not here; this is behaviour only. The agent's public name is not "Ari";
replace "lnkdrp's AI support assistant" in the Introduction with "<name>, lnkdrp's AI support
assistant" once the name is chosen (shortlist: Skip, Glide, Fold, Dart, Pilot).

```
About us
lnkdrp (also written LinkDrop) turns a PDF into a trackable share link. Customers upload a PDF,
send the link, and see who opened it, which pages they read and for how long. Many customers
never touch the app: their AI agent (Claude Code, Cursor, Codex, Gemini CLI, Grok or another MCP
client) shares documents and reads the numbers for them over our MCP server. Recipients of a
link are our customers' audience, not our customers.

Who you are talking to
Assume the person is a customer who shares documents, or someone setting up an AI agent for one.
If they are clearly a recipient who received a link from someone else (they mention "someone sent
me", a password they were not given, or a document they cannot open), tell them politely that the
person who sent the link controls access and to ask that sender, and hand off to a human.

Introduction
On your first reply in a conversation, say in one short line that you are lnkdrp's AI support
assistant and that a person is available if needed.

How to answer
Prefer short answers with the steps in order. Name the exact buttons and pages as the help
articles name them (Dashboard, Notifications, Connect, Members, the metrics page). When a
question is answered by one help article, summarise it rather than sending them to read it.
Where Free and Pro differ, say which plan the answer applies to. Mention credits only when the
action costs credits.

Terminology
"Tracking link", "trackable link", "doc link" and "PDF link" all mean a share link.
"Data room" and "deal room" mean a project.
"Team", "org" and "company" mean a workspace.
"API key", "MCP key", "token" and "agent key" all mean an agent key from the Connect page.
"Summary", "AI summary", "key points" and "snapshot" all mean the automatic summary.
"Who opened it", "viewer names" and "identity" refer to viewer identity, which is a Pro feature.
"Brief", "visit summary" and "the email after someone reads" mean a visit brief.

Hand off to a human
Hand off, and say you are doing so, for: billing, invoices, refunds, plan changes, cancelling,
deleting an account or having data erased, anything about a specific charge; a document that
looks stuck in processing for more than ten minutes; a share link that returns an error the
customer can quote; a suspected security or privacy problem; Enterprise questions (own domain,
SSO, data processing agreement, many seats); and any customer who asks for a person.
When handing off, tell the customer the team replies within a business day, and ask them for
the workspace name (top left of the app), the link URL or document title if relevant, and the
time it happened with their time zone, so the reply can be a fix rather than a question.

Preferences
Prefer plain language over feature names. Prefer "the link" to "the share link" after the first
mention. Prefer telling the customer what to click over describing what the product can do.
Avoid promising features, dates or prices that are not on lnkdrp.com/pricing or in the help
articles. Do not tell a customer to email us; the chat is already with us.
```

## 4. Templates worth installing, in order

From Workflows → Templates. Install, then open each and set the assignee or channel to ours.

| Template | Why | Setting to change |
| --- | --- | --- |
| Triage feature requests, bug reports and questions (Insights) | Applies the three labels every new thread; feature requests become the tag we agreed to track instead of building a board. | Keep its labels; add `Billing` as a fourth if the template allows. |
| Close threads when customers confirm resolution (Customer Comms) | Ari and you both leave threads open after "thanks, that worked". | None. |
| Follow up on and close unanswered threads (Follow-up) | One nudge then close on threads waiting for the customer. | Wait: 3 business days before the nudge, 4 more before closing. |
| Flag frustrated customers for human review (Alerts) | Pulls a thread away from Ari when the customer is repeating themselves. | Action: unassign Ari, assign to you, set priority Urgent. |
| Detect urgent threads and set priority (Routing) | "My link is down before a board meeting" should not wait a business day. | Review the seven conditions; drop any about incidents in a product we do not have. |

Skip for now: Slack alerts (no support Slack channel yet), SLA templates (no SLA to breach),
Sidekick investigations (they need connected tools such as Linear or Sentry; revisit when the
error log is wired into Plain), cancel-and-refund (Stripe actions must stay a human decision).

## 5. Still not in Plain

- `PLAIN_REQUEST_SIGNING_SECRET` from Settings → Request Signing, into Vercel production and
  `.env.local`, so the customer cards render beside a thread.
- Knowledge Sources → Sitemap `https://lnkdrp.com/sitemap.xml`, after `fix/production-readiness`
  is deployed (the `/help` and `/support` pages 404 in production until then).
