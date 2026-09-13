"use client";
/**
 * About copy shared by the About page and the About modal.
 *
 * Mirrors the homepage message: built for AI, agent-first via MCP, context before the click,
 * and engagement you can read back.
 */
export default function AboutCopy() {
  return (
    <div className="space-y-5 text-sm leading-7 text-[var(--muted)]">
      <p className="text-base font-semibold text-[var(--fg)]">Built for AI.</p>
      <p>
        Sharing a document is the most common thing anyone does on the internet, and it still works
        the way it did twenty years ago: you send a link, the other person opens it, and everything
        after that is guesswork.
      </p>
      <p>
        LinkDrop is built by people who send a lot of fundraising, sales, and legal PDFs, and
        who now do most of that work with an AI agent at their side. So LinkDrop meets you there.
        Generate a share link from your favorite agent through the LinkDrop MCP interface, hand it
        to a recipient, and read the clicks, views, and usage back through your agent or our
        dashboard. Every link opens with a summary and key points, so readers know what
        they&apos;re getting before they commit time.
      </p>
      <div className="grid gap-4 pt-1 sm:grid-cols-2">
        <div>
          <div className="font-medium text-[var(--fg)]">Built for agents</div>
          <p className="mt-1 text-xs leading-5">
            Create links and pull stats from Claude, Cursor, or any MCP client. No browser
            required.
          </p>
        </div>
        <div>
          <div className="font-medium text-[var(--fg)]">AI-powered context</div>
          <p className="mt-1 text-xs leading-5">
            A summary and key points, written automatically after every upload, before anyone
            opens the file.
          </p>
        </div>
        <div>
          <div className="font-medium text-[var(--fg)]">Engagement insights</div>
          <p className="mt-1 text-xs leading-5">
            See who viewed, how long they spent, which pages they cared about, and when they
            downloaded.
          </p>
        </div>
        <div>
          <div className="font-medium text-[var(--fg)]">Version history and AI compare</div>
          <p className="mt-1 text-xs leading-5">
            Replace the file and the link stays the same. Compare any two versions and get a plain
            account of what changed.
          </p>
        </div>
      </div>
    </div>
  );
}
