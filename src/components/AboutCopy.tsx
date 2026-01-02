"use client";
/**
 * Render the AboutCopy UI.
 */


export default function AboutCopy() {
  return (
    <div className="space-y-4 text-sm leading-7 text-zinc-600 dark:text-zinc-300">
      <p>
        Link and doc sharing is the most ubiquitous activity on the internet, yet no one has really
        made it better.
      </p>
      <p>
        Most tools focus on moving files around. You send a link, the other person opens it, and
        everything else is on them. Skimming, orienting, and deciding how much time to spend.
      </p>
      <p>
        LinkDrop is built by people who send a lot of fundraising, sales, and legal documents.
        We’ve felt that gap firsthand. Instead of just sending a document, you share a link that
        gives the reader enough context to understand what they’re looking at before they go deep.
      </p>
      <p>
        <span className="font-medium text-zinc-800 dark:text-zinc-100">Essence</span>
        <br />
        A short summary and key points so the reader can orient quickly.
      </p>
      <p>
        <span className="font-medium text-zinc-800 dark:text-zinc-100">Relevance</span>
        <br />
        Enough signal to decide whether it’s worth going deeper.
      </p>
    </div>
  );
}




