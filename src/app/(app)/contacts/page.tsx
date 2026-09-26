/**
 * Page for `/contacts` — everyone this workspace has heard from.
 *
 * A contact is gathered, never typed in (docs/prds/lnkdrp-contacts.md): the page is the list of
 * people who introduced themselves, signed in to read, asked to download or dropped a file in a
 * request inbox, sorted and filtered the way a founder in a raise needs to work a list of forty.
 */
import type { Metadata } from "next";

import ContactsPageClient from "./pageClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Contacts" };

export default function ContactsPage() {
  return <ContactsPageClient />;
}
