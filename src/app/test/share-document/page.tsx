import type { Metadata } from "next";
import { PdfJsViewer } from "@/components/PdfJsViewer";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { headers } from "next/headers";

type SampleAiOutput = {
  openGraph?: {
    title?: string;
    description?: string;
  };
};

type OgDims = { width: number; height: number };

function readOgDims(): OgDims {
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

export async function generateMetadata(): Promise<Metadata> {
  const jsonPath = join(process.cwd(), "public", "sample", "sample-ai-output.json");
  const data = JSON.parse(readFileSync(jsonPath, "utf8")) as SampleAiOutput;

  const title = data.openGraph?.title || "Test - Share Document";
  const description =
    data.openGraph?.description || "Test page for sharing a document with OG previews.";

  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? "https";
  const metadataBase = new URL(`${proto}://${host}`);

  const { width, height } = readOgDims();
  const ogImageUrl = new URL("/test/share-document/og.png", metadataBase);

  return {
    title,
    description,
    metadataBase,
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [{ url: ogImageUrl, width, height, alt: title }],
    },
    openGraph: {
      type: "website",
      title,
      description,
      images: [{ url: ogImageUrl, width, height, alt: title }],
    },
  };
}

export default function ShareDocumentTestPage() {
  const pdfUrl = "/sample/usavx.pdf";

  return <PdfJsViewer url={pdfUrl} initialPage={1} />;
}




