import { ImageResponse } from "next/og";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const runtime = "nodejs";
export const contentType = "image/png";

type OgDims = { width: number; height: number };

type SampleAiOutput = {
  openGraph?: {
    imagePath?: string;
  };
};

function readSampleAiOutput(): SampleAiOutput {
  const jsonPath = join(process.cwd(), "public", "sample", "sample-ai-output.json");
  return JSON.parse(readFileSync(jsonPath, "utf8")) as SampleAiOutput;
}

function readDims(): OgDims {
  const metaPath = join(process.cwd(), "tmp", "usavx-page1.json");
  const meta = JSON.parse(readFileSync(metaPath, "utf8")) as {
    width?: number;
    height?: number;
  };
  const width = Number(meta.width);
  const height = Number(meta.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error(`Invalid OG dimensions in ${metaPath}`);
  }
  return { width, height };
}

export const size = readDims();

export default async function TwitterImage() {
  try {
    const sample = readSampleAiOutput();
    const relPath = sample.openGraph?.imagePath || "tmp/usavx-page1.png";
    const pngPath = join(process.cwd(), relPath);
    const png = readFileSync(pngPath);
    const base64 = png.toString("base64");

    return new ImageResponse(
      (
        <img
          src={`data:image/png;base64,${base64}`}
          width={size.width}
          height={size.height}
          alt="Document preview"
        />
      ),
      { width: size.width, height: size.height },
    );
  } catch {
    return new ImageResponse(
      (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 48,
            background: "white",
            color: "black",
          }}
        >
          Twitter image unavailable
        </div>
      ),
      { width: size.width, height: size.height },
    );
  }
}



