/**
 * Page for `/contacts/:contactId` — one person, across everything the workspace shared with them.
 *
 * The reader page (`/doc/:id/metrics/viewer/:key`) answers "what did she read here"; this page
 * answers "who is she, what has she touched, and what do we want to remember about her". It
 * links down to the reader pages rather than copying them.
 */
import type { Metadata } from "next";

import ContactPageClient from "./pageClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Contact" };

export default async function ContactPage({ params }: { params: Promise<{ contactId: string }> }) {
  const { contactId } = await params;
  return <ContactPageClient contactId={decodeURIComponent(contactId ?? "")} />;
}
