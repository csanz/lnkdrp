/**
 * Page for `/contacts/:contactId` — one person, across everything the workspace shared with them.
 *
 * The reader page (`/doc/:id/metrics/viewer/:key`) answers "what did she read here"; this page
 * answers "who is she, what has she touched, and what do we want to remember about her". It
 * links down to each document's metrics rather than copying anything, and the per-reader page it
 * would ideally link to is deferred with the rest of decision 8: a contact does not carry the
 * reader key (`u_<userId>` / `a_<botIdHash>`) that addresses one.
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
