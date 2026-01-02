import { connectMongoose } from "@/lib/db/mongoose";

/**
 * Connect to MongoDB using the project's cached Mongoose connection.
 *
 * This is a small convenience wrapper used by server-side modules (e.g. auth),
 * so they don't need to import the mongoose layer directly.
 */
// Re-export a single "MongoDB connect" entrypoint for auth and other server code.
// This intentionally reuses the project's existing cached Mongoose connection.
export async function connectMongo() {
  return connectMongoose();
}



