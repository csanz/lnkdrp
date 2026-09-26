---
title: Privacy and security
description: What lnkdrp stores about you and your recipients, how share links are protected, and what deleting removes.
order: 90
---

A plain-language summary. The [Privacy Policy](/privacy) and [Terms of Service](/tos) take precedence.

## Your account

Sign-in is through Google only. lnkdrp stores the email, name and account identifier Google provides. No password is stored. Card details for Pro are entered on Stripe's checkout page; lnkdrp never sees the full card number.

## Your documents

lnkdrp stores the PDFs you upload, the text extracted from them, a preview image and an image of each page, plus the AI summaries, key points and version comparisons generated for them. Files are stored at unlisted addresses and served through the app under the share settings you set.

AI features use OpenAI's API. The extracted text and page images are sent when a summary, comparison or visit brief is generated. Content sent through the API is not used to train models. Uploading a document means it will be processed this way.

## What is recorded about recipients

When someone opens a share link, lnkdrp records:

- That the document was opened, which pages were viewed, how long they spent on each page and how many times they returned to a page.
- Whether they downloaded the PDF, if you allowed downloads.
- Their IP address, kept for security and abuse prevention. It is not shown to you.
- Their name and email, only if they chose to enter them in the viewer. A signed-in viewer's account identity is used instead.
- An address they give, in the workspace's [contacts](/help/contacts): one row per person per workspace, with the documents they read and the dates. Contacts are never shared between workspaces and are never mailed anything.

To tell repeat visits apart, a random identifier is stored in the viewer's browser. It is not linked across different owners' documents. Clearing browser storage removes it.

lnkdrp does not fingerprint devices, does not store browser user-agent strings, and runs no third-party analytics or advertising trackers. The public homepage loads a map dataset from a public CDN for its animation; nothing like that runs inside the signed-in app.

## Share link protection

- Share links are addressed by a random identifier. A disabled, expired, archived or deleted link answers exactly like a link that never existed.
- Share passwords are stored as salted hashes and, so that owners and admins can reveal them, in encrypted form. Wrong guesses are rate-limited per link.
- After a correct password, a signed cookie keeps the browser unlocked for 14 days. It does not contain the password.
- Share pages carry a no-index instruction and lnkdrp's robots rules tell crawlers not to fetch them, so documents stay out of search engines.
- Agent keys are shown once and stored only as a hash. Revoking one takes effect at once.

## Emails

Workspace members are emailed when recipients open or finish reading a link, on by default, and every such email has a link to turn it off. The Privacy Policy tells viewers that the person who shared a link may be emailed when they open it. See [Notifications and visit briefs](/help/notifications-and-visit-briefs).

## Deleting documents and workspaces

Deleting a workspace removes its contacts with it. Deleting a document, project or workspace removes it from view and disables its share links immediately. The records and files are marked deleted rather than erased at once and may remain in backups until purged. Contact support if you need a document permanently erased. Viewer activity is kept as long as the related document exists.

## Deleting your account

You can delete your account yourself from the dashboard, with a typed confirmation.

- Your account stops working straight away: you are signed out, your agent keys stop, and every share link in a workspace only you belong to stops opening.
- Workspaces you share with other people carry on without you.
- Your documents and data are kept for 30 days in case this was a mistake, then deleted for good, files included. To change your mind within those 30 days, email us.

There is no self-service data export yet. To receive a copy of your data, or to delete specific information without closing your account, email hi@lnkdrp.com and it is handled by hand.

Error records are deleted after 14 days. Billing records are kept as required for tax and accounting.
