/**
 * Vitest setup for agent tests.
 *
 * Loads `.env` and `.env.local` so OPENAI_API_KEY and other test env vars are available.
 */

import path from "node:path";
import process from "node:process";

import dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), ".env"), quiet: true });
dotenv.config({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });


