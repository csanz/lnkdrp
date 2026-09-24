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
  logo?: { url: string; alt?: string };
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

/** The page Plain's "Reply" emails link back to; see `src/app/support/page.tsx`. */
export const SUPPORT_PATH = "/support";

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

/** Whether the widget will paint itself dark for this theme value: "auto" defers to the OS. */
function rendersDark(theme: "light" | "dark" | "auto"): boolean {
  if (theme !== "auto") return theme === "dark";
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** The full `Plain.init` options for this visitor: launcher and identity when signed in; hidden (unless on `/support`) and verified-by-code otherwise. */
function optionsFor(appId: string, customer: PlainChatCustomer | null, theme: "light" | "dark" | "auto", showLauncher: boolean): PlainInitOptions {
  return {
    appId,
    theme,
    hideLauncher: !customer && !showLauncher,
    // Always on: Plain's "Require email verification" is enabled workspace-side and refuses a
    // widget that does not set this. A signed-in user still sees no code prompt, because the
    // server-signed `emailHash` below is the other accepted proof of the same thing.
    requireAuthentication: true,
    // No "Powered by Plain" footer: the person is talking to lnkdrp, and a second company's
    // logo in the panel only raises the question of who is answering.
    hideBranding: true,
    // Our mark in the welcome header, on the widget's own base background (white in light,
    // near-black in dark), so the icon follows the theme. Absolute because Plain loads it as
    // an <img> inside its own tree; the origin is ours either way.
    ...(typeof window !== "undefined" ? { logo: { url: `${window.location.origin}/icon-${rendersDark(theme) ? "white" : "black"}.svg`, alt: "lnkdrp" } } : {}),
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

/**
 * The one widget size its custom properties do not reach. The welcome heading ("Hey <name>, how
 * can we help?") is hard-coded to `clamp(1.25rem, 4.5vh, 2rem)`, up to 32px, which dwarfs
 * everything else on our pages. The widget's shadow root is open and its own styles arrive as
 * adopted stylesheets, which sort after any `<style>` in the tree, so the override needs the
 * higher specificity of the root id rather than a later position. Everything else (font, body
 * sizes, logo size) is set on the host in `globals.css`.
 */
const SHADOW_STYLE_ID = "lnkdrp-plain-chat-style";
// `!important` because the widget's own rules for these sit under `.wrapper--floating`, an
// element inside the shadow tree, which a host-level custom property cannot reach.
const SHADOW_STYLE = [
  "#plain-chat-root .wrapper--floating { --logo-size: 40px !important; }",
  "#plain-chat-root .intro_header h1 { font-size: 1.125rem !important; line-height: 1.3 !important; font-weight: 600 !important; letter-spacing: 0 !important; }",
].join(" ");

const SHADOW_POLL_MS = 100;
const SHADOW_GIVE_UP_MS = 15_000;

/**
 * Appends the overrides to the widget's shadow root once. The widget builds its host on its
 * own schedule after `init`, so this polls briefly for the shadow root rather than assuming
 * it exists, and gives up quietly: without it the chat still works, only larger.
 */
function injectShadowStyle(): void {
  const started = Date.now();
  const attempt = (): boolean => {
    // `div#plain-chat`, not `getElementById`: the widget names its host `plain-chat`, and so did
    // the `<Script id>` that loads it, so `getElementById` answered with the script tag (first in
    // document order, no shadow root) and this polled for fifteen seconds and gave up. The
    // heading stayed at the widget's 32px on every page, with the override sitting right here.
    const root = document.querySelector<HTMLElement>("div#plain-chat")?.shadowRoot;
    if (!root) return false;
    if (!root.getElementById(SHADOW_STYLE_ID)) {
      const style = document.createElement("style");
      style.id = SHADOW_STYLE_ID;
      style.textContent = SHADOW_STYLE;
      root.appendChild(style);
    }
    return true;
  };
  if (attempt()) return;
  const timer = window.setInterval(() => {
    if (attempt() || Date.now() - started > SHADOW_GIVE_UP_MS) window.clearInterval(timer);
  }, SHADOW_POLL_MS);
}

/** Loads Plain's widget script once and keeps its options in step with theme, session and route. */
export default function PlainChat({ appId, customer }: { appId: string; customer: PlainChatCustomer | null }) {
  const pathname = usePathname();
  const { resolvedTheme } = useTheme();
  const theme: "light" | "dark" | "auto" = resolvedTheme === "dark" ? "dark" : resolvedTheme === "light" ? "light" : "auto";
  const initialised = useRef(false);
  const viewer = isViewerPath(pathname);
  // `/support` is where Plain's notification emails send a customer back to; the launcher must
  // be there for anonymous visitors too.
  const showLauncher = pathname === SUPPORT_PATH;

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
    plain.update(optionsFor(appId, customer, theme, showLauncher));
  }, [appId, customer, theme, viewer, showLauncher]);

  if (viewer) return null;

  return (
    <Script
      // Not `plain-chat`: that is the id the widget gives its own host element (see `injectShadowStyle`).
      id="plain-chat-script"
      src={PLAIN_CHAT_SCRIPT}
      strategy="afterInteractive"
      onLoad={() => {
        const plain = window.Plain;
        if (!plain || initialised.current) return;
        plain.init(optionsFor(appId, customer, theme, showLauncher));
        initialised.current = true;
        injectShadowStyle();
      }}
    />
  );
}
