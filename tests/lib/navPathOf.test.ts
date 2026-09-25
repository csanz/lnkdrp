/**
 * `navPathOf`: the navigation overlay compares a link's pathname, not its whole href (code review
 * 2026-09-23, H7). A History chip to `/doc/x/history#v-3` from `/doc/x/history` is the same page.
 */
import { describe, expect, it } from "vitest";

import { navPathOf } from "../../src/lib/client/navPathOf";

describe("navPathOf", () => {
  it("drops the hash", () => {
    expect(navPathOf("/doc/abc/history#v-3")).toBe("/doc/abc/history");
  });

  it("drops the query, and the query with a hash after it", () => {
    expect(navPathOf("/doc/abc?tab=links")).toBe("/doc/abc");
    expect(navPathOf("/doc/abc?tab=links#top")).toBe("/doc/abc");
  });

  it("leaves a plain pathname alone", () => {
    expect(navPathOf("/project/room")).toBe("/project/room");
    expect(navPathOf("/")).toBe("/");
  });

  it("a same-page hash link compares equal to the current pathname; another document does not", () => {
    const pathname = "/doc/abc/history";
    expect(navPathOf("/doc/abc/history#v-2") === pathname).toBe(true);
    expect(navPathOf("/doc/def/history#v-2") === pathname).toBe(false);
  });
});
