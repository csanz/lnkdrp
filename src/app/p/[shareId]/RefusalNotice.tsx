/**
 * The one recipient-facing refusal panel for `/p/**`.
 *
 * A project link can stop resolving for three reasons a recipient may legitimately be told apart:
 * the owner switched it off, it hit its expiry date, or the project is gone. "Expired" is worth its
 * own words — it is the one refusal the recipient can act on ("ask them for a fresh link") rather
 * than sit puzzled in front of, and the date was the sender's deliberate choice, not a secret.
 *
 * Nothing else leaks: no project name, no document count, no owner. Compare `/s/:shareId`, which
 * collapses every refusal into `notFound()` — there the *document title* is what a refusal would
 * give away, and there is nothing to say that is not that.
 */
import BrandHeader from "@/components/BrandHeader";
import { PROJECT_SHARE_THEME } from "./shareTheme";

export type ProjectRefusalKind = "expired" | "disabled";

const COPY: Record<ProjectRefusalKind, { title: string; body: string }> = {
  expired: {
    title: "This link has expired",
    body: "The sender set an expiry date on this link and it has passed. Ask them for a new one.",
  },
  disabled: {
    title: "This project is no longer shared",
    body: "The owner disabled sharing for this project link, or it may be invalid.",
  },
};

export default function RefusalNotice({ kind }: { kind: ProjectRefusalKind }) {
  const copy = COPY[kind];
  return (
    <main className="min-h-screen bg-[var(--bg)] text-[var(--fg)]" style={PROJECT_SHARE_THEME}>
      <BrandHeader />
      <div className="mx-auto w-full max-w-3xl px-6 py-10">
        <div className="text-lg font-semibold tracking-tight text-[var(--fg)]">{copy.title}</div>
        <div className="mt-2 text-sm text-[var(--muted)]">{copy.body}</div>
      </div>
    </main>
  );
}
