"use client";

import { CheckIcon } from "@heroicons/react/20/solid";
import { Square2StackIcon } from "@heroicons/react/24/outline";

type Props = {
  copyDone: boolean;
  isCopying?: boolean;
  disabled?: boolean;
  onCopy: () => void;
  className: string;
  iconClassName?: string;
  label?: string;
  copiedLabel?: string;
  copyAriaLabel?: string;
  copiedAriaLabel?: string;
  copyTitle?: string;
  copiedTitle?: string;
};

/**
 * Reusable "copy to clipboard" button UI that matches the animated behavior used on the doc detail page:
 * it swaps the icon (and optional label) when `copyDone` is true.
 */
export function CopyButton({
  copyDone,
  isCopying,
  disabled,
  onCopy,
  className,
  iconClassName = "h-4 w-4",
  label,
  copiedLabel,
  copyAriaLabel,
  copiedAriaLabel,
  copyTitle,
  copiedTitle,
}: Props) {
  const effectiveCopyAriaLabel = copyAriaLabel ?? (label ? `Copy ${label}` : "Copy");
  const effectiveCopiedAriaLabel = copiedAriaLabel ?? "Copied";
  const effectiveCopyTitle = copyTitle ?? effectiveCopyAriaLabel;
  const effectiveCopiedTitle = copiedTitle ?? effectiveCopiedAriaLabel;

  const effectiveLabel = label ?? null;
  const effectiveCopiedLabel = copiedLabel ?? (label ? "Copied" : null);

  return (
    <button
      type="button"
      onClick={onCopy}
      disabled={Boolean(disabled) || Boolean(isCopying)}
      className={className}
      aria-label={copyDone ? effectiveCopiedAriaLabel : effectiveCopyAriaLabel}
      title={copyDone ? effectiveCopiedTitle : effectiveCopyTitle}
    >
      {copyDone ? <CheckIcon className={iconClassName} /> : <Square2StackIcon className={iconClassName} />}
      {effectiveLabel ? <span>{copyDone ? effectiveCopiedLabel : effectiveLabel}</span> : null}
      <span className="sr-only">{copyDone ? "Copied" : "Copy"}</span>
    </button>
  );
}


