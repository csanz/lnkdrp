/**
 * CopyTextButton — small "copy to clipboard" helper for admin tooling (and anywhere else).
 *
 * Uses `navigator.clipboard` when available with a best-effort fallback.
 */
"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";

async function copyTextToClipboard(text: string) {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Fallback for older browsers.
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "true");
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
}

export default function CopyTextButton({
  text,
  label = "Copy",
  copiedLabel = "Copied",
  disabled,
  className,
}: {
  text: string;
  label?: string;
  copiedLabel?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");
  const canCopy = Boolean(text) && !disabled;

  return (
    <Button
      variant="outline"
      size="sm"
      className={className ?? "bg-[var(--panel-2)] text-[12px]"}
      disabled={!canCopy}
      title={state === "copied" ? "Copied" : state === "error" ? "Copy failed" : "Copy to clipboard"}
      onClick={() => {
        setState("idle");
        void (async () => {
          try {
            await copyTextToClipboard(text);
            setState("copied");
            window.setTimeout(() => setState("idle"), 1200);
          } catch {
            setState("error");
            window.setTimeout(() => setState("idle"), 2000);
          }
        })();
      }}
    >
      {state === "copied" ? copiedLabel : state === "error" ? "Copy failed" : label}
    </Button>
  );
}


