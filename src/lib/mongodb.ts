import { connectMongoose } from "@/lib/db/mongoose";

// Re-export a single "MongoDB connect" entrypoint for auth and other server code.
// This intentionally reuses the project's existing cached Mongoose connection.
export async function connectMongo() {
  return connectMongoose();
}



