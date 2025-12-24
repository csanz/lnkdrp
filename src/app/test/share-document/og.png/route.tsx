import { readFileSync } from "node:fs";
import { join } from "node:path";
import { imageResponseFromBytes, mimeFromPath } from "@/lib/og/imageResponse";

export const runtime = "nodejs";

type SampleAiOutput = {
  openGraph?: {
    imagePath?: string;
  };
};

/**
 * Load the sample AI output JSON bundled under /public for testing.
 */
function readSampleAiOutput(): SampleAiOutput {
  const jsonPath = join(process.cwd(), "public", "sample", "sample-ai-output.json");
  return JSON.parse(readFileSync(jsonPath, "utf8")) as SampleAiOutput;
}

/**
 * Test-only OG image route that returns the sample preview image.
 */
export async function GET() {
  const sample = readSampleAiOutput();
  const relPath = sample.openGraph?.imagePath || "tmp/usavx-page1.png";

  const pngPath = join(process.cwd(), relPath);
  const bytes = readFileSync(pngPath);

  return imageResponseFromBytes({
    bytes,
    mime: mimeFromPath(relPath),
    alt: "Document preview",
    cacheControl: "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400",
  });
}



