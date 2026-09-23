"use client";

/**
 * The Plain chat widget: the bubble a customer uses to reach support without leaving the app.
 *
 * Mounted once from the root layout. What it does depends on who is looking:
 *
 * - **Signed in**: the launcher shows, and the chat is already theirs. The server signed their
 *   email (`plainChatCustomer`), so Plain opens on their threads and the customer cards render
 *   beside the conversation with no "enter your email" step.
 * - **Anonymous, on the marketing site**: no launcher. The widget is loaded but hidden, and a
 *   `SupportLink` ("Talk to us" on pricing) opens it; Plain then verifies them by emailed code.
 * - **A recipient reading a shared document** (`/s/…`, `/p/…`, request and download links):
 *   nothing is mounted at all. They are the customer's audience, not our customer, and a support
 *   bubble on a document somebody else sent them would be the wrong company answering.
 *
 * The widget follows the app theme through `next-themes`, and `Plain.update` keeps it in step
 * when the theme or the session changes without a reload.
 */
import { usePathname } from "next/navigation";
import Script from "next/script";
import { useTheme } from "next-themes";
import { useEffect, useRef } from "react";

import type { PlainChatCustomer } from "@/lib/support/plain/chat";

type ThemedColor = string | { light: string; dark: string };

type PlainInitOptions = {
  appId: string;
  hideLauncher?: boolean;
  requireAuthentication?: boolean;
  theme?: "auto" | "light" | "dark";
  hideBranding?: boolean;
  position?: { right?: string; bottom?: string; zIndex?: string };
  style?: { brandColor?: ThemedColor; brandBackgroundColor?: ThemedColor; launcherBackgroundColor?: ThemedColor; launcherIconColor?: ThemedColor };
  customerDetails?: { email: string; emailHash: string; fullName?: string; externalId?: string };
  links?: { icon?: string; text: string; url: string }[];
};

type PlainGlobal = {
  init: (opts: PlainInitOptions) => void;
  update: (opts: Partial<PlainInitOptions>) => void;
  open: () => void;
  close: () => void;
  isInitialized: () => boolean;
};

declare global {
  interface Window {
    Plain?: PlainGlobal;
  }
}

export const PLAIN_CHAT_SCRIPT = "https://chat.cdn-plain.com/index.js";

/** Recipient-facing routes: never mount the widget there. */
const VIEWER_PREFIXES = ["/s/", "/p/", "/r/", "/request/", "/request-view/", "/download/", "/share/"];

/** True on a page a document recipient sees rather than an lnkdrp customer. */
export function isViewerPath(pathname: string | null): boolean {
  if (!pathname) return false;
  return VIEWER_PREFIXES.some((p) => pathname === p.slice(0, -1) || pathname.startsWith(p));
}

/** Opens the chat if the widget is on the page and ready. Returns false so callers can fall back to mail. */
export function openSupportChat(): boolean {
  const plain = typeof window !== "undefined" ? window.Plain : undefined;
  if (!plain || !plain.isInitialized()) return false;
  plain.open();
  return true;
}

/** The full `Plain.init` options for this visitor: launcher and identity when signed in, hidden and verified-by-code otherwise. */
function optionsFor(appId: string, customer: PlainChatCustomer | null, theme: "light" | "dark" | "auto"): PlainInitOptions {
  return {
    appId,
    theme,
    hideLauncher: !customer,
    requireAuthentication: !customer,
    position: { right: "20px", bottom: "20px", zIndex: "60" },
    style: {
      brandColor: "#000000",
      brandBackgroundColor: "#000000",
      launcherBackgroundColor: { light: "#000000", dark: "#ffffff" },
      launcherIconColor: { light: "#ffffff", dark: "#000000" },
    },
    ...(customer
      ? {
          customerDetails: {
            email: customer.email,
            emailHash: customer.emailHash,
            ...(customer.fullName ? { fullName: customer.fullName } : {}),
            externalId: customer.externalId,
          },
        }
      : {}),
  };
}

/** Loads Plain's widget script once and keeps its options in step with theme, session and route. */
export default function PlainChat({ appId, customer }: { appId: string; customer: PlainChatCustomer | null }) {
  const pathname = usePathname();
  const { resolvedTheme } = useTheme();
  const theme: "light" | "dark" | "auto" = resolvedTheme === "dark" ? "dark" : resolvedTheme === "light" ? "light" : "auto";
  const initialised = useRef(false);
  const viewer = isViewerPath(pathname);

  // Keep the widget in step with theme, session and route changes after the first init. The
  // script injects its own DOM, so returning null below does not remove a launcher that is
  // already on the page; client-side navigation onto a recipient route hides it here instead.
  useEffect(() => {
    if (!initialised.current) return;
    const plain = window.Plain;
    if (!plain) return;
    if (viewer) {
      plain.close();
      plain.update({ hideLauncher: true });
      return;
    }
    plain.update(optionsFor(appId, customer, theme));
  }, [appId, customer, theme, viewer]);

  if (viewer) return null;

  return (
    <Script
      id="plain-chat"
      src={PLAIN_CHAT_SCRIPT}
      strategy="afterInteractive"
      onLoad={() => {
        const plain = window.Plain;
        if (!plain || initialised.current) return;
        plain.init(optionsFor(appId, customer, theme));
        initialised.current = true;
      }}
    />
  );
}
