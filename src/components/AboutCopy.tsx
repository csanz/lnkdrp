"use client";
/**
 * Render the AboutCopy UI.
 */


export default function AboutCopy() {
  return (
    <div className="space-y-5 text-sm leading-7 text-[var(--muted)]">
      <p>
        Link and doc sharing is the most ubiquitous activity on the internet, yet no one has really
        made it better. Most tools focus on moving files around. You send a link, the other person
        opens it, and everything else is on them.
      </p>
      <p>
        LinkDrop is built by people who send a lot of fundraising, sales, and legal documents.
        Instead of just sending a document, you share a link that gives the reader enough context
        to understand what they&apos;re looking at before they go deep.
      </p>
      <div className="grid gap-4 pt-1 sm:grid-cols-3">
        <div>
          <div className="font-medium text-[var(--fg)]">AI-powered context</div>
          <p className="mt-1 text-xs leading-5">
            AI agents extract summaries, key points, category, and relevance signals. Readers know
            what they&apos;re getting before they open it.
          </p>
        </div>
        <div>
          <div className="font-medium text-[var(--fg)]">Request repositories</div>
          <p className="mt-1 text-xs leading-5">
            Collect documents with structured inboxes. AI scores submissions against your criteria.
          </p>
        </div>
        <div>
          <div className="font-medium text-[var(--fg)]">Engagement insights</div>
          <p className="mt-1 text-xs leading-5">
            See who viewed, how long they spent, and which pages they cared about.
          </p>
        </div>
      </div>
    </div>
  );
}




