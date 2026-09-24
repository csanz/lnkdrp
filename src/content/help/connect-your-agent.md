---
title: Connect your agent
description: Let Claude Code, Cursor, Codex or any MCP client share PDFs and read the numbers in your workspace.
order: 70
---

## What the MCP server is

lnkdrp has an MCP server at `https://mcp.lnkdrp.com/mcp`. Add it to your AI client and your agent can upload PDFs, create and manage share links, set passwords, read stats and replace files in your workspace, using its own key. It is a remote server, so there is nothing to install locally.

Agents work under the same plan limits and credits as you do. They never take a seat.

## Create an agent key

- Open **Connect** in the app (the sidebar entry or `/connect`). Workspace owners and admins can create keys.
- Give the key a name, such as the agent or machine it is for.
- The key is shown once. Copy it straight away; lnkdrp keeps only a hash.
- A workspace can have up to 10 active keys. Use one per agent so you can revoke a single one without touching the others.
- Revoke a key from the same page at any time.

A key belongs to one workspace. To connect another workspace, switch to it, create a key there, and add it to your client under its own name. Connect names it for you, such as `lnkdrp-personal` or `lnkdrp-acme`.

## Set up your client

Connect shows the exact command or settings for your client with your key filled in. Guides:

- [Claude Code](/mcp/claude-code)
- [Cowork](/mcp/cowork)
- [Cursor](/mcp/cursor)
- [Codex](/mcp/codex)
- [Gemini CLI](/mcp/gemini-cli)
- [Grok](/mcp/grok)
- [Any MCP client](/mcp/any-client)

The overview is at [/mcp](/mcp). To check the connection end to end, ask your agent: "Call lnkdrp_whoami and tell me which workspace you are connected to."

## Sign in instead of using a key

Clients that support signing in to MCP servers, including Claude Code, Cursor, Codex and Gemini CLI, can connect without a key. Add the lnkdrp server to the client without an authorization header, then choose to sign in when the client asks. lnkdrp opens in your browser, you pick the workspace the agent should work in, and click **Allow**. The client keeps its own credential from then on.

- Agents connected this way appear on **Connect** next to your keys, marked "Signed in", with the same **Revoke** button. Revoking stops the agent at once.
- One connection is one workspace, the same as a key. To give an agent a second workspace, add the server again under another name and pick that workspace when you sign in.
- Viewers can connect an agent too. It can read but not change anything, matching their role.
- Keys keep working. Use a key when there is no browser to sign in from, such as a script or a server.

## What your agent can do

- Share a PDF from a URL or a local file and get the link back, with an optional password and download setting.
- Replace the PDF on a document you already shared. Every link keeps working.
- Create, list, search, update, disable and delete share links, each with its own label, audience, password and expiry.
- Check or reveal a link's password so it can tell you what it is later.
- Read stats: views, opens, downloads, pages viewed and time spent for a link or a document. On Pro, every reader with time per page.
- List and search your documents, archive, star and tag them.
- Create projects, add documents to them and manage project links.
- Read the activity feed, including an audit trail of what agents did.
- Report which workspace, plan and credits it is working with.

Agents do not receive or configure notification emails.

## Agent-written summaries are free

When your agent supplies its own summary and key points while sharing or replacing a PDF, the automatic AI summary is skipped and costs 0 credits. Without them, the automatic summary costs 1 credit like any upload.

## Destructive actions ask first

Deleting a share link, deleting a document, archiving a document, deleting a project and deleting a project link all confirm with you first. The agent shows what would be affected, such as how many recipients opened the link and when, and will not proceed without your yes. Disabling a link or removing a document from a project is reversible, so those do not ask.

## Agent status in the dashboard

- The left sidebar shows **Connected** with the number of agents, or **Not connected**.
- The Connect page lists your keys, which client last used each one and when.
- The activity feed attributes agent actions to the client, for example "Claude Code created a share link".

## Troubleshooting

- **"lnkdrp already exists"**: your client keeps one server per name. Remove the old entry, then add it again with the new key. For a different workspace, add it under that workspace's own name instead.
- **401 unauthorized**: the key was revoked or pasted with a space or line break. Keys start with `lnk_` and are 36 characters. Create a new one if in doubt.
- **Wrong workspace**: create a key in the workspace you want and add it under its own name.
