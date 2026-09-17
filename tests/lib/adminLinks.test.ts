/**
 * The admin Links browser's shaping (`src/lib/admin/linksAdmin.ts`).
 *
 * The point of the module is that "is this link live?" is not one stored field, and the two places
 * that answer it — the server's filter and the page's pill — must give the same answer. These tests
 * pin the precedence order and check each filter fragment against the state it claims to select,
 * including the one that matters for privacy: the password filter asks whether a hash exists and
 * never touches the value.
 */
import { describe, expect, test } from "vitest";
import {
  ADMIN_LINK_STATE_FILTERS,
  deriveLinkState,
  isAdminLinkStateFilter,
  linkStateFilterFragment,
  linkStateLabel,
  pickDocTitle,
  publicLinkPath,
} from "@/lib/admin/linksAdmin";

const NOW = new Date("2026-09-17T12:00:00.000Z");
const PAST = "2026-09-16T12:00:00.000Z";
const FUTURE = "2026-09-18T12:00:00.000Z";

describe("admin/linksAdmin deriveLinkState", () => {
  test("a plain enabled link with no expiry is active", () => {
    expect(deriveLinkState({ enabled: true, archivedAt: null, expiresAt: null }, NOW)).toBe("active");
  });

  test("an expiry still in the future leaves the link active", () => {
    expect(deriveLinkState({ enabled: true, expiresAt: FUTURE }, NOW)).toBe("active");
  });

  test("an expiry in the past reads as expired", () => {
    expect(deriveLinkState({ enabled: true, expiresAt: PAST }, NOW)).toBe("expired");
  });

  test("an expiry exactly at now is already expired", () => {
    expect(deriveLinkState({ enabled: true, expiresAt: NOW }, NOW)).toBe("expired");
  });

  test("the enabled flag outranks a future expiry", () => {
    expect(deriveLinkState({ enabled: false, expiresAt: FUTURE }, NOW)).toBe("disabled");
  });

  test("archived outranks everything else, since clearing the expiry would not bring it back", () => {
    expect(deriveLinkState({ enabled: false, archivedAt: PAST, expiresAt: PAST }, NOW)).toBe("archived");
  });

  test("a projection that dropped `enabled` does not invent a disabled link", () => {
    // The schema default is true; absent must not read as false.
    expect(deriveLinkState({}, NOW)).toBe("active");
  });

  test("an unparseable stored date is ignored rather than read as expired", () => {
    expect(deriveLinkState({ enabled: true, expiresAt: "not a date" }, NOW)).toBe("active");
  });

  test("Date instances work as well as ISO strings", () => {
    expect(deriveLinkState({ enabled: true, expiresAt: new Date(PAST) }, NOW)).toBe("expired");
  });
});

describe("admin/linksAdmin linkStateLabel", () => {
  test("names each state", () => {
    expect(linkStateLabel("active")).toBe("Active");
    expect(linkStateLabel("disabled")).toBe("Disabled");
    expect(linkStateLabel("expired")).toBe("Expired");
    expect(linkStateLabel("archived")).toBe("Archived");
  });

  test("separates a link the document switch turned off from one the sender revoked", () => {
    expect(linkStateLabel("disabled", { disabledByDocSwitch: true })).toBe("Disabled (doc switch)");
    expect(linkStateLabel("disabled", { disabledByDocSwitch: false })).toBe("Disabled");
  });

  test("the doc-switch note only applies to disabled rows", () => {
    expect(linkStateLabel("archived", { disabledByDocSwitch: true })).toBe("Archived");
  });
});

describe("admin/linksAdmin filter fragments", () => {
  test("no filter means no constraint", () => {
    expect(linkStateFilterFragment("", NOW)).toBeNull();
  });

  test("active excludes archived, disabled and lapsed rows", () => {
    expect(linkStateFilterFragment("active", NOW)).toEqual({
      enabled: true,
      archivedAt: null,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: NOW } }],
    });
  });

  test("disabled is exactly the enabled flag being off", () => {
    expect(linkStateFilterFragment("disabled", NOW)).toEqual({ enabled: false });
  });

  test("expired is an expiry at or before now", () => {
    expect(linkStateFilterFragment("expired", NOW)).toEqual({ expiresAt: { $ne: null, $lte: NOW } });
  });

  test("archived is the soft-delete stamp being set", () => {
    expect(linkStateFilterFragment("archived", NOW)).toEqual({ archivedAt: { $ne: null } });
  });

  test("the password filter asks only whether a hash exists", () => {
    const fragment = linkStateFilterFragment("password", NOW);
    expect(fragment).toEqual({ passwordHash: { $ne: null } });
    // No fragment may ever name the reveal-copy ciphertext or its key material.
    const serialized = JSON.stringify(fragment);
    expect(serialized).not.toContain("passwordEnc");
    expect(serialized).not.toContain("passwordSalt");
  });

  test("every advertised filter value produces a fragment", () => {
    for (const state of ADMIN_LINK_STATE_FILTERS) {
      expect(linkStateFilterFragment(state, NOW)).not.toBeNull();
    }
  });
});

describe("admin/linksAdmin isAdminLinkStateFilter", () => {
  test("accepts the empty value and every advertised filter", () => {
    expect(isAdminLinkStateFilter("")).toBe(true);
    for (const state of ADMIN_LINK_STATE_FILTERS) expect(isAdminLinkStateFilter(state)).toBe(true);
  });

  test("rejects anything else, so a bad query param can 400 instead of scanning", () => {
    expect(isAdminLinkStateFilter("live")).toBe(false);
    expect(isAdminLinkStateFilter("ACTIVE")).toBe(false);
  });
});

describe("admin/linksAdmin publicLinkPath", () => {
  test("document links resolve at /s/:shareId", () => {
    expect(publicLinkPath("doc", "abc123")).toBe("/s/abc123");
  });

  test("a legacy row with no kind is a document link", () => {
    expect(publicLinkPath(null, "abc123")).toBe("/s/abc123");
  });

  test("project links resolve at /p/:shareId", () => {
    expect(publicLinkPath("project", "abc123")).toBe("/p/abc123");
  });

  test("a missing slug has no path", () => {
    expect(publicLinkPath("doc", null)).toBeNull();
    expect(publicLinkPath("doc", "")).toBeNull();
  });
});

describe("admin/linksAdmin pickDocTitle", () => {
  test("prefers the owner's title", () => {
    expect(pickDocTitle({ title: "Series A deck", docName: "Deck", fileName: "deck.pdf" })).toBe("Series A deck");
  });

  test("falls back through docName to the upload filename", () => {
    expect(pickDocTitle({ title: null, docName: "Deck", fileName: "deck.pdf" })).toBe("Deck");
    expect(pickDocTitle({ fileName: "deck.pdf" })).toBe("deck.pdf");
  });

  test("treats whitespace-only names as missing and trims what it returns", () => {
    expect(pickDocTitle({ title: "   ", fileName: "  deck.pdf " })).toBe("deck.pdf");
  });

  test("a deleted or unreadable document has no title", () => {
    expect(pickDocTitle(null)).toBeNull();
    expect(pickDocTitle({})).toBeNull();
  });
});
