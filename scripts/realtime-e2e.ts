/**
 * End-to-end check of a realtime server, local or deployed: sign a ticket with the shared secret,
 * connect, expect `hello`, insert one activity row into the database it watches, expect the
 * `activity` frame for that workspace, then clean up. Proves Atlas → change stream → socket → client.
 *
 *   TEST_REALTIME_URL=wss://dev-lnkdrp-realtime.fly.dev npx tsx --env-file=.env.local scripts/realtime-e2e.ts
 *   TEST_REALTIME_URL=ws://localhost:8788 npx tsx --env-file=.env.local scripts/realtime-e2e.ts
 */
import WebSocket from "ws";
import mongoose, { Types } from "mongoose";
import { signRealtimeTicket } from "@/lib/realtime/ticket";
import { connectMongo } from "@/lib/mongodb";

type Frame = { type: string; [k: string]: unknown };

async function main() {
  const url = (process.env.TEST_REALTIME_URL ?? "").replace(/\/+$/, "");
  if (!url) throw new Error("TEST_REALTIME_URL is required");
  const orgId = new Types.ObjectId();
  const userId = new Types.ObjectId();
  const { ticket } = signRealtimeTicket({ userId: String(userId), orgId: String(orgId) });

  const frames: Frame[] = [];
  const ws = new WebSocket(`${url}/?t=${encodeURIComponent(ticket)}`);
  ws.on("message", (d) => {
    const f = JSON.parse(String(d)) as Frame;
    frames.push(f);
    if (f.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
  });
  const waitFor = (type: string, ms: number) =>
    new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for "${type}" frame; got ${frames.map((f) => f.type).join(",") || "nothing"}`)), ms);
      const check = () => {
        const f = frames.find((x) => x.type === type);
        if (f) {
          clearTimeout(timer);
          resolve(f);
        }
      };
      ws.on("message", check);
      check();
    });

  const t0 = Date.now();
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`upgrade refused: HTTP ${res.statusCode}`)));
  });
  const hello = await waitFor("hello", 10_000);
  console.log(`connected + hello in ${Date.now() - t0} ms:`, JSON.stringify(hello));

  await connectMongo();
  const col = mongoose.connection.db!.collection("activityevents");
  const t1 = Date.now();
  const ins = await col.insertOne({
    orgId,
    actorKind: "user",
    actorUserId: userId,
    type: "share.viewed",
    createdDate: new Date(),
    meta: { test: "fly-realtime-e2e" },
  });
  try {
    const ev = await waitFor("activity", 15_000);
    console.log(`activity frame in ${Date.now() - t1} ms:`, JSON.stringify(ev));
  } finally {
    await col.deleteOne({ _id: ins.insertedId });
  }
  ws.close();
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
