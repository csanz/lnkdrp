---
title: Slack
description: Post opens, visit briefs, replaced documents, received files and new documents to a Slack channel, and route each project to its own channel.
order: 75
---

## What the Slack integration does

Connect a Slack channel and lnkdrp posts a short message there, with a link back, at five moments:

- **Opened**: a recipient opens one of your share links for the first time.
- **Visit brief**: a recipient finished reading and the brief is ready.
- **Replaced**: a document got a new version, with what changed.
- **Received**: someone uploaded a file to one of your request inboxes.
- **Added**: a document was added to a project, so the people watching that room know it landed.

Messages go out one per event, at the same moments the notification emails do. The integration only posts. It does not read your Slack, it has no commands, and it never replies.

The connection belongs to the workspace, not to a person. Every member sees the same channels.

## Connect a channel

1. Open **Integrations** in the sidebar and choose **Slack**. Workspace owners and admins can connect.
2. Click **Add to Slack**. Slack opens its own screen; pick the channel there. Private channels work too.
3. You land back on the Slack page with the channel listed. Click **Send a test message** to see one arrive.

The first channel you connect is the **default**: anything not routed to another channel posts there.

## More than one channel

More than one channel is a Pro feature, and so is routing a project to one. Free connects a single channel, and that channel posts everything: all five kinds of message, on every plan.

Click **Add channel** to connect another one. Each channel has its own switches and its own projects.

- **Projects**: on a channel's card, pick the projects (data rooms and request inboxes) that should post there. A project posts to one channel; picking it on another card moves it.
- A document that belongs to two routed projects posts to both channels. A document in no routed project posts to the default channel.
- With a single channel, everything posts there.

## Choose what posts

Each channel has five switches, all on to begin with: **Opens**, **Visit briefs**, **Replaced documents**, **Received files** and **New documents**. Turn off what you do not want in that channel. These are workspace switches, so they do not change anyone's email preferences.

## What a message says

A message is one line, a short context line, and a link to the document, the reader's page or the version history. Names are plain text, never Slack mentions.

Who the reader is follows your plan, the same as the emails:

- On **Pro**, opens and briefs name the reader when they are known.
- On **Free**, the reader is "someone", and the visit brief posts as a short recap without the write-up.

See [Analytics](/help/analytics) and [Notifications and visit briefs](/help/notifications-and-visit-briefs) for what each plan records.

## Busy channels

A deck sent to a large list can open many times a minute. A channel receives at most 30 messages a minute; the rest of that minute is summed up in one "and N more" line so the channel stays readable.

## Disconnect

Click **Disconnect** on a channel's card. lnkdrp forgets the channel at once and tells Slack. You can also remove the lnkdrp app from Slack's side; the card then shows **Disconnected** with the reason, and you can connect it again whenever you like.

If a card shows Disconnected without you doing anything, the channel or the app was removed in Slack. Connect it again from the same page.

## Agents

An agent connected over MCP can read which channels are connected and how projects are routed. It cannot connect, change or disconnect a channel; a person does that from the Integrations page.
