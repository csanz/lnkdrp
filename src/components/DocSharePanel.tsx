"use client";

import { CheckIcon } from "@heroicons/react/20/solid";
import type { RefObject } from "react";

type Props = {
  shareUrl: string;
  shareInputRef: RefObject<HTMLInputElement | null>;
  isCopying: boolean;
  copyDone: boolean;
  onCopy: () => void;
};

export default function DocSharePanel({
  shareUrl,
  shareInputRef,
  isCopying,
  copyDone,
  onCopy,
}: Props) {
  const displayValue = shareUrl || "Generating link…";

  return (
    <div className="min-h-0 overflow-auto rounded-2xl border border-zinc-200 bg-white p-5">
      <div className="text-sm font-semibold">Share link</div>
      <div className="mt-1 text-xs font-medium text-zinc-500">PDF ready</div>

      <div className="mt-3 flex items-stretch gap-2">
        <input
          ref={shareInputRef}
          value={displayValue}
          readOnly
          className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm font-medium text-zinc-900 focus:outline-none focus:ring-2 focus:ring-black/10"
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            onCopy();
          }}
          aria-label="Share link"
        />
        <button
          type="button"
          onClick={onCopy}
          disabled={!shareUrl || isCopying}
          className="shrink-0 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors duration-150 hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-black/20 focus:ring-offset-2 focus:ring-offset-white disabled:opacity-50"
          aria-label={copyDone ? "Copied" : "Copy link"}
          title={copyDone ? "Copied" : "Copy link"}
        >
          <span className="inline-flex items-center gap-2">
            {copyDone ? <CheckIcon className="h-5 w-5 text-white/95" /> : null}
            <span>{copyDone ? "Copied" : "Copy"}</span>
          </span>
        </button>
      </div>

      {/* a11y: announce copy state */}
      <div className="sr-only" aria-live="polite">
        {copyDone ? "Copied to clipboard" : ""}
      </div>
    </div>
  );
}

