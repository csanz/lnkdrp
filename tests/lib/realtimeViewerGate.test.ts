/**
 * The realtime channel must not be a second, ungated source of viewer identity.
 *
 * Who may see a reader's volunteered name is a plan decision, and it is made in exactly one place:
 * `GET /api/activity` computes `showViewerIdentity = plan === "pro"` and deletes `viewerName` /
 * `viewerEmail` for everyone else. The realtime process has no notion of a workspace's tier — its
 * ticket authorises a socket for a user and a workspace and says nothing about billing — so any
 * identity it puts on the wire is identity handed out with no gate at all. It did exactly that:
 * both `viewer` frames carried `name: doc.viewerName` to the whole workspace room, so a Free
 * workspace was pushed the name the product had told the reader it would not show.
 *
 * These tests drive the two change-stream handlers that emit that frame — `shareviews` (a reader
 * opened a document, or re-answered "introduce yourself") and `projectlinkviews` (a visitor landed
 * on a data room and opened nothing) — with a fullDocument that has a name on it, and assert the
 * bytes that reach a socket. They assert on the serialised frame rather than an object, because
 * what leaks is what `JSON.stringify` puts on the wire.
 *
 * The frame itself still has to fire: it is the refetch nudge every metrics surface listens on, and
 * an identity change is one of the things worth refetching for. So each case checks both halves —
 * the nudge arrives, the name does not.
 *
 * The server is a standalone script (`main()` runs at import), so mongo, `ws` and `node:http` are
 * mocked out from under it and the socket is joined to its room through the server's own
 * `connection` handler.
 */
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

const ORG = "6512c0ffee00000000000001";
const DOC = "6512c0ffee00000000000002";
const READER_NAME = "Dana Whitfield";

// The module refuses to load without these, by design — a misconfigured realtime host should not
// boot. Set before the dynamic import below, and put back afterwards: the tests/lib pool runs
// every file in one process, and another file here decides whether it talks to a real database by
// looking at MONGODB_URI.
const priorEnv = {
  MONGODB_URI: process.env.MONGODB_URI,
  REALTIME_SECRET: process.env.REALTIME_SECRET,
};
process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/lnkdrp-test";
process.env.REALTIME_SECRET = "test-secret";

function restoreEnv() {
  for (const [key, value] of Object.entries(priorEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

type Handler = (...args: unknown[]) => void;

/** collection name → event name → handlers the server registered on that change stream. */
const streamHandlers = new Map<string, Map<string, Handler[]>>();

function fakeStream(collection: string) {
  const events = new Map<string, Handler[]>();
  streamHandlers.set(collection, events);
  const stream = {
    closed: false,
    on(event: string, fn: Handler) {
      const list = events.get(event) ?? [];
      list.push(fn);
      events.set(event, list);
      return stream;
    },
    close: async () => undefined,
  };
  return stream;
}

function emitChange(collection: string, change: unknown) {
  const handlers = streamHandlers.get(collection)?.get("change") ?? [];
  expect(handlers.length).toBeGreaterThan(0);
  for (const fn of handlers) fn(change);
}

vi.mock("mongoose", () => {
  const connection = {
    readyState: 1,
    db: {
      collection: (name: string) => ({ watch: () => fakeStream(name) }),
    },
  };
  return {
    default: {
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      connection,
    },
  };
});

let wss: { emit: (event: string, ...args: unknown[]) => void } | null = null;

vi.mock("ws", () => {
  class FakeWebSocketServer {
    handlers = new Map<string, Handler[]>();
    constructor() {
      wss = this as unknown as { emit: (event: string, ...args: unknown[]) => void };
    }
    on(event: string, fn: Handler) {
      const list = this.handlers.get(event) ?? [];
      list.push(fn);
      this.handlers.set(event, list);
      return this;
    }
    emit(event: string, ...args: unknown[]) {
      for (const fn of this.handlers.get(event) ?? []) fn(...args);
    }
    handleUpgrade() {}
  }
  return { WebSocketServer: FakeWebSocketServer, WebSocket: { OPEN: 1 } };
});

vi.mock("node:http", () => ({
  default: {
    createServer: () => ({
      on: () => undefined,
      listen: (_port: number, cb?: () => void) => cb?.(),
      close: (cb?: () => void) => cb?.(),
    }),
  },
}));

vi.mock("../../src/lib/realtime/ticket", () => ({
  realtimeSecret: () => "test-secret",
  verifyRealtimeTicket: () => ({ orgId: ORG, userId: "u1" }),
}));

/** The one socket in the workspace room; `sent` is everything the server wrote to it. */
const sent: string[] = [];
const socket = {
  orgId: ORG,
  userId: "u1",
  missedPings: 0,
  expiresAt: Date.now() + 3_600_000,
  readyState: 1,
  bufferedAmount: 0,
  send: (data: string) => sent.push(data),
  on: () => socket,
  close: () => undefined,
  terminate: () => undefined,
};

/** The frames of one type this socket received, parsed. */
function framesOfType(type: string) {
  return sent
    .map((raw) => JSON.parse(raw) as { type?: string })
    .filter((frame) => frame.type === type);
}

beforeAll(async () => {
  // A stray `process.exit` here would take the test worker with it; the server calls it on a dead
  // stream and on a missing secret, neither of which this run should reach.
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`realtime server called process.exit(${code})`);
  }) as never);
  // The heartbeat interval is the only unref'd-free timer in the process; faked so it cannot hold
  // the worker open after the assertions are done.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

  await import("../../realtime/server");
  restoreEnv();
  // `main()` is async and not awaited by the module; one turn is enough for its single `await`.
  await new Promise((resolve) => setImmediate(resolve));

  expect(wss).not.toBeNull();
  wss?.emit("connection", socket);
  sent.length = 0; // drop the `hello`
});

afterEach(() => {
  sent.length = 0;
});

describe("realtime viewer frames carry no reader identity", () => {
  test("a reader arriving on a share link broadcasts the nudge without their name", () => {
    emitChange("shareviews", {
      operationType: "insert",
      fullDocument: {
        orgId: ORG,
        docId: DOC,
        shareId: "abc123",
        viewerName: READER_NAME,
        viewerEmailSnapshot: "dana@example.com",
      },
    });

    const frames = framesOfType("viewer");
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({
      type: "viewer",
      orgId: ORG,
      viewer: { docId: DOC, shareId: "abc123" },
    });
    expect(sent.join("\n")).not.toContain(READER_NAME);
    expect(sent.join("\n")).not.toContain("dana@example.com");
  });

  test("a name changing still nudges, and still says nothing about the name", () => {
    emitChange("shareviews", {
      operationType: "update",
      updateDescription: { updatedFields: { viewerName: READER_NAME } },
      fullDocument: {
        orgId: ORG,
        docId: DOC,
        shareId: "abc123",
        viewerName: READER_NAME,
      },
    });

    const frames = framesOfType("viewer") as { viewer: Record<string, unknown> }[];
    expect(frames).toHaveLength(1);
    expect(Object.keys(frames[0].viewer).sort()).toEqual(["docId", "shareId"]);
    expect(sent.join("\n")).not.toContain(READER_NAME);
  });

  test("a visitor landing on a project link broadcasts the arrival without their name", () => {
    emitChange("projectlinkviews", {
      operationType: "insert",
      fullDocument: {
        orgId: ORG,
        shareId: "room77",
        viewerName: READER_NAME,
      },
    });

    const frames = framesOfType("viewer");
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({
      type: "viewer",
      orgId: ORG,
      viewer: { docId: null, shareId: "room77" },
    });
    expect(sent.join("\n")).not.toContain(READER_NAME);
  });

  test("the reading frame identifies the reader by digest only", () => {
    emitChange("shareviews", {
      operationType: "update",
      updateDescription: { updatedFields: { lastViewedAt: new Date() } },
      fullDocument: {
        orgId: ORG,
        docId: DOC,
        shareId: "abc123",
        botIdHash: "deadbeef",
        viewerName: READER_NAME,
      },
    });

    const frames = framesOfType("reading") as { reading: Record<string, unknown> }[];
    expect(frames).toHaveLength(1);
    expect(frames[0].reading.viewerKey).toBe("deadbeef");
    expect(sent.join("\n")).not.toContain(READER_NAME);
  });
});
