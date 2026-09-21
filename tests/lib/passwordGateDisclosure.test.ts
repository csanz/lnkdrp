/**
 * The share password gate, before the password has been given.
 *
 * Two things are pinned here, both of them about a data room rather than a single document:
 *
 * - The gate renders nothing about what is behind it. It used to show `title` and `previewUrl`
 *   whenever a caller handed them over, and every caller passed `null` on purpose — an arrangement
 *   that is correct only for as long as nobody forgets. In front of a room, a title and a cover are
 *   one of the *documents in the room*, so a forgetful caller would have told a stranger who never
 *   gave the password what the room holds. The props are still accepted (three pages pass them) and
 *   are now inert, which is what these tests assert: real values in, nothing out.
 * - The copy fits a room too. "Enter the password to view this document" was the only wording, and
 *   `/p/:shareId` is several.
 *
 * Rendered to static markup rather than inspected as an element tree: the claim is about what a
 * recipient's browser receives, and a prop that leaks through an `alt` or a `src` would pass an
 * assertion written against the tree's text children.
 */
import { describe, expect, test, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/components/BrandHeader", () => ({
  default: function BrandHeader() {
    return null;
  },
}));
vi.mock("@/lib/http/fetchJson", () => ({ fetchJson: vi.fn() }));
vi.mock("@/lib/botId", () => ({ getOrCreateBotId: () => "bot-id" }));

const { default: PasswordGate } = await import("@/components/PasswordGate");

/** What a caller must not be able to disclose through the gate, however it is passed. */
const SECRET_TITLE = "Acme Series A — cap table";
const SECRET_PREVIEW = "https://store123.public.blob.vercel-storage.com.com/docs/64f0c0ffee/preview.png";

/** The gate's markup for one set of props, as a recipient's browser would receive it. */
function render(props: Record<string, unknown>): string {
  return renderToStaticMarkup(createElement(PasswordGate as never, { shareId: "pl_locked01", ...props } as never));
}

describe("PasswordGate discloses nothing behind the password", () => {
  test("a title and a preview handed to it are not rendered", () => {
    const html = render({ title: SECRET_TITLE, previewUrl: SECRET_PREVIEW, scope: "project" });
    expect(html).not.toContain(SECRET_TITLE);
    expect(html).not.toContain(SECRET_PREVIEW);
    // No image at all: the cover of any one document in a room is an answer to "what is in here".
    expect(html).not.toContain("<img");
    // It is still the gate, not an empty page.
    expect(html).toContain("Password required");
  });

  test("the callers that pass null are unchanged", () => {
    expect(render({ title: null, previewUrl: null })).toBe(render({}));
  });
});

describe("PasswordGate copy", () => {
  test("a data room is not 'this document'", () => {
    const html = render({ scope: "project" });
    expect(html).toContain("Enter the password to view this data room.");
    expect(html).not.toContain("this document");
  });

  test("a document link still says document", () => {
    expect(render({ scope: "document" })).toContain("Enter the password to view this document.");
  });

  test("unsaid stays true of both", () => {
    const html = render({});
    expect(html).toContain("Enter the password to continue.");
    expect(html).not.toContain("this document");
    expect(html).not.toContain("this data room");
  });
});
