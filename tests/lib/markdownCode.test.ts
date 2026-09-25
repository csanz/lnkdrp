/**
 * Inline code spans stay inline and fenced blocks get exactly one `<pre>` (code review 2026-09-23,
 * M21). react-markdown v9 dropped the `inline` prop the renderer used to branch on.
 */
/* eslint-disable react/no-children-prop -- `Markdown` takes its text as `children`; there is no JSX in a .ts test. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { codeText, isBlockCode } from "@/lib/client/markdownCode";
import Markdown from "@/components/Markdown";

describe("isBlockCode", () => {
  it("a language class or a newline means a block; anything else is a span", () => {
    expect(isBlockCode("language-ts", "const a = 1;")).toBe(true);
    expect(isBlockCode(undefined, "line one\nline two")).toBe(true);
    expect(isBlockCode(undefined, "npm test")).toBe(false);
    expect(isBlockCode("some-other-class", "x")).toBe(false);
  });

  it("codeText joins react-markdown's children array", () => {
    expect(codeText(["a", "b"])).toBe("ab");
    expect(codeText("c")).toBe("c");
    expect(codeText(undefined)).toBe("");
  });
});

describe("Markdown code rendering", () => {
  it("renders an inline span as <code> with no <pre> around it", () => {
    const html = renderToStaticMarkup(createElement(Markdown, { children: "Run `npm test` now." }));
    expect(html).toContain("<code");
    expect(html).toContain("npm test");
    expect(html).not.toContain("<pre");
  });

  it("renders a fenced block as one <pre> with one <code>, never nested", () => {
    const html = renderToStaticMarkup(createElement(Markdown, { children: "```ts\nconst a = 1;\n```" }));
    expect(html.match(/<pre/g)?.length ?? 0).toBe(1);
    expect(html.match(/<code/g)?.length ?? 0).toBe(1);
    expect(html).toContain("const a = 1;");
  });

  it("renders a fence with no language as a block too", () => {
    const html = renderToStaticMarkup(createElement(Markdown, { children: "```\nline one\nline two\n```" }));
    expect(html.match(/<pre/g)?.length ?? 0).toBe(1);
  });
});
