/**
 * What does one attached page image actually cost?
 *
 *   npm run measure:image-tokens
 *
 * The compare attaches page renders to the model, and for a long time their cost was arithmetic
 * over OpenAI's documented tiling rule rather than anything measured. The rule is ambiguous on the
 * one case that matters: an image whose shortest side is already below 768px. Read one way a
 * 480x270 thumbnail is scaled up to 1365x768 and costs six tiles, the same as the 1200px render;
 * read the other it stays 480x270 and costs one. Those readings differ by 4.3x on the single
 * largest component of every compare, and the wrong one shipped once - described in a commit
 * message as token-neutral while it was quietly putting 736,700 tokens into a 128k window.
 *
 * So ask the provider instead of the documentation. Same prompt, same model, one image, varying
 * only the dimensions; the difference from the no-image baseline is the image. Tiling depends on
 * dimensions alone, so the pictures are generated rather than pulled from a real document - which
 * also means this costs a few tenths of a cent and touches no customer data.
 *
 * Findings as of 2026-09-22 (tokens per image, baseline subtracted):
 *
 *     image                gpt-4o-mini   gpt-4o
 *     480x270   thumb            8,500      255
 *     768x432                   14,167      425
 *     1024x576                  25,501      765
 *     1200x675  render          36,835    1,105
 *
 * Two things follow. Sub-768 images are not scaled up, so the thumbnail really was one tile. And
 * the mini/4o ratio is exactly 33.33 at every size while mini's input price is only 16.67x
 * cheaper - so the same picture costs about twice as much in dollars on the smaller model. That is
 * why `modelForCompare` routes anything carrying images to gpt-4o.
 *
 * Re-run this whenever the attached renditions change size, the model changes, or a tier's page
 * cap moves.
 */
import "dotenv/config";
import sharp from "sharp";
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });

/** A page-like image. Structure rather than a flat field, so nothing is trivially compressible. */
async function makeImage(w: number, h: number): Promise<string> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect width="100%" height="100%" fill="#ffffff"/>
    <rect x="${w * 0.06}" y="${h * 0.08}" width="${w * 0.3}" height="${h * 0.09}" fill="#1f2937"/>
    <rect x="${w * 0.06}" y="${h * 0.3}" width="${w * 0.6}" height="${h * 0.04}" fill="#6b7280"/>
    <rect x="${w * 0.06}" y="${h * 0.4}" width="${w * 0.75}" height="${h * 0.04}" fill="#9ca3af"/>
    <circle cx="${w * 0.8}" cy="${h * 0.75}" r="${Math.min(w, h) * 0.12}" fill="#2563eb"/>
  </svg>`;
  const buf = await sharp(Buffer.from(svg)).jpeg({ quality: 78 }).toBuffer();
  return `data:image/jpeg;base64,${buf.toString("base64")}`;
}

/** The renditions the pipeline stores, plus the two intermediate sizes worth knowing about. */
const CASES: Array<[string, [number, number] | null]> = [
  ["no image (baseline)", null],
  ["480x270   thumbUrl, 16:9", [480, 270]],
  ["768x432   16:9", [768, 432]],
  ["1024x576  16:9", [1024, 576]],
  ["1200x675  imageUrl, 16:9", [1200, 675]],
  ["480x621   thumbUrl, letter portrait", [480, 621]],
  ["1200x1553 imageUrl, letter portrait", [1200, 1553]],
];

/** The advanced tier's ceiling: ten pages, previous and new. */
const ADVANCED_IMAGES = 20;

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error("\n  OPENAI_API_KEY is not set.\n");
    process.exit(1);
  }

  for (const model of ["gpt-4o-mini", "gpt-4o"]) {
    console.log(`\n=== ${model} ===`);
    const results: Array<[string, number]> = [];
    for (const [label, dims] of CASES) {
      const content: Array<Record<string, unknown>> = [{ type: "text", text: "Reply with the single word: ok" }];
      if (dims) content.push({ type: "image", image: await makeImage(dims[0], dims[1]) });
      const { usage } = await generateText({
        model: openai(model),
        messages: [{ role: "user", content } as never],
        maxOutputTokens: 16,
        temperature: 0,
      });
      results.push([label, usage.inputTokens ?? 0]);
    }
    const base = results[0][1];
    for (const [label, tok] of results.slice(1)) {
      const per = tok - base;
      console.log(
        label.padEnd(38),
        String(per).padStart(7),
        "tok/img",
        `   ${ADVANCED_IMAGES} imgs =`,
        String(per * ADVANCED_IMAGES).padStart(8),
      );
    }
  }
  console.log("\n  gpt-4o-mini's context window is 128,000 tokens; gpt-4o's is the same.\n");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\n  Failed:", e instanceof Error ? e.message : e, "\n");
    process.exit(1);
  });
