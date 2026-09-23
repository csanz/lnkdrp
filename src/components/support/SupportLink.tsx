"use client";

/**
 * The one way the product points at support.
 *
 * Renders as a plain `mailto:support@lnkdrp.com` link, so it works with JavaScript off, with the
 * widget unconfigured, and in a crawler. When the Plain chat widget is on the page and ready,
 * the click opens it instead and the mail client never launches. Either way the person lands
 * in the same Plain queue: email and chat are two doors to one room.
 *
 * `subject` survives the fallback only; the chat has no subject line. Put anything the support
 * team needs in the text the person reads, not the subject.
 */
import type { MouseEvent, ReactNode } from "react";

import { openSupportChat } from "@/components/support/PlainChat";

export const SUPPORT_EMAIL = "support@lnkdrp.com";

/** A mailto link to support that opens the chat widget instead when it is on the page. */
export default function SupportLink({
  subject,
  className,
  children,
}: {
  subject?: string;
  className?: string;
  children: ReactNode;
}) {
  const href = subject ? `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}` : `mailto:${SUPPORT_EMAIL}`;
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (openSupportChat()) e.preventDefault();
  };
  return (
    <a href={href} className={className} onClick={onClick}>
      {children}
    </a>
  );
}
