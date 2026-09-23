"use client";

/**
 * Opens the Plain chat as soon as the widget is ready. Used by `/support`, the page Plain's
 * notification emails link back to. The widget script loads after hydration and initialises on
 * its own schedule, so this polls briefly rather than assuming it is there on mount, and gives
 * up quietly: the page's own links are the fallback.
 */
import { useEffect } from "react";

import { openSupportChat } from "@/components/support/PlainChat";

const POLL_MS = 250;
const GIVE_UP_MS = 15_000;

/** Renders nothing; tries to open the chat until it succeeds or the deadline passes. */
export default function SupportOpener() {
  useEffect(() => {
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (openSupportChat() || Date.now() - started > GIVE_UP_MS) window.clearInterval(timer);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, []);
  return null;
}
