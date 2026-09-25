/**
 * Global listener for out-of-credits UX.
 *
 * Listens for `lnkdrp:out-of-credits` and shows a single modal across the app.
 * Includes a short cooldown to avoid repeated triggers spamming the user.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import OutOfCreditsModal, { type OutOfCreditsCta } from "@/components/OutOfCreditsModal";
import { funnelSurface, trackFunnel } from "@/lib/client/funnel";
import { OUT_OF_CREDITS_EVENT, type OutOfCreditsReason } from "@/lib/client/outOfCredits";

const COOLDOWN_MS = 8_000;

/** Mount once in the app shell: shows the out-of-credits modal for `lnkdrp:out-of-credits` events. */
export default function OutOfCreditsListener() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<OutOfCreditsReason>("exhausted");
  const lastShownAtRef = useRef(0);

  useEffect(() => {
    function onOutOfCredits(e: Event) {
      if (open) return;
      const now = Date.now();
      if (now - lastShownAtRef.current < COOLDOWN_MS) return;
      lastShownAtRef.current = now;
      const detail = (e as CustomEvent<{ reason?: OutOfCreditsReason }>).detail;
      const next: OutOfCreditsReason = detail?.reason === "daily_cap" ? "daily_cap" : "exhausted";
      setReason(next);
      setOpen(true);
      // The credits wall was shown; the server's `credits.exhausted` row is the step before.
      trackFunnel("modal_shown", { reason: next, from: funnelSurface(window.location.pathname) });
    }

    window.addEventListener(OUT_OF_CREDITS_EVENT, onOutOfCredits);
    return () => window.removeEventListener(OUT_OF_CREDITS_EVENT, onOutOfCredits);
  }, [open]);

  const onCta = (cta: OutOfCreditsCta) =>
    trackFunnel("cta_clicked", { reason, cta, from: funnelSurface(window.location.pathname) });

  return (
    <OutOfCreditsModal
      open={open}
      reason={reason}
      onCta={onCta}
      onClose={() => setOpen(false)}
      onManageCredits={() => {
        setOpen(false);
        router.push("/dashboard/limits");
      }}
      onBuyCredits={() => {
        setOpen(false);
        router.push("/credits");
      }}
    />
  );
}


