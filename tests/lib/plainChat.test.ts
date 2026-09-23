/**
 * Plain chat identity: the email hash is the credential Plain trusts, so it must be computed only
 * when there is a secret, only for a real session, and exactly the way Plain's docs compute it.
 * The viewer-path rule is pinned because a support bubble on a recipient's document is the wrong
 * company answering.
 */
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";

import { isViewerPath } from "@/components/support/PlainChat";
import { plainChatAppId, plainChatCustomer, plainChatEmailHash } from "@/lib/support/plain/chat";

const SECRET = "chat-secret";

afterEach(() => {
  delete process.env.PLAIN_CHAT_SECRET;
  delete process.env.NEXT_PUBLIC_PLAIN_CHAT_APP_ID;
});

describe("plain chat identity", () => {
  test("hash matches Plain's recipe and is null without a secret", () => {
    expect(plainChatEmailHash("ada@example.com")).toBeNull();
    process.env.PLAIN_CHAT_SECRET = SECRET;
    const expected = createHmac("sha256", SECRET).update("ada@example.com").digest("hex");
    expect(plainChatEmailHash("ada@example.com")).toBe(expected);
    expect(plainChatEmailHash("  Ada@Example.com ")).toBe(expected);
  });

  test("customer details only for a signed-in user with an email and a configured secret", () => {
    process.env.PLAIN_CHAT_SECRET = SECRET;
    expect(plainChatCustomer(null)).toBeNull();
    expect(plainChatCustomer({ id: "u1", email: "" })).toBeNull();
    expect(plainChatCustomer({ id: "", email: "ada@example.com" })).toBeNull();
    const c = plainChatCustomer({ id: "u1", email: "Ada@Example.com", name: " Ada " });
    expect(c).toEqual({ email: "ada@example.com", emailHash: plainChatEmailHash("ada@example.com"), fullName: "Ada", externalId: "u1" });
    delete process.env.PLAIN_CHAT_SECRET;
    expect(plainChatCustomer({ id: "u1", email: "ada@example.com" })).toBeNull();
  });

  test("app id is null when unset or blank", () => {
    expect(plainChatAppId()).toBeNull();
    process.env.NEXT_PUBLIC_PLAIN_CHAT_APP_ID = "  ";
    expect(plainChatAppId()).toBeNull();
    process.env.NEXT_PUBLIC_PLAIN_CHAT_APP_ID = "app_123";
    expect(plainChatAppId()).toBe("app_123");
  });

  test("viewer paths are recipient routes, not the app or marketing site", () => {
    for (const p of ["/s/abc", "/p/abc/doc1", "/r/tok", "/request/tok", "/request-view/tok", "/download/tok", "/share/verify"]) {
      expect(isViewerPath(p)).toBe(true);
    }
    for (const p of ["/", "/pricing", "/dashboard", "/doc/abc", "/share-links", "/settings", null]) {
      expect(isViewerPath(p)).toBe(false);
    }
  });
});
