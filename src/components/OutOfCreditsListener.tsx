/**
 * Global listener for out-of-credits UX.
 *
 * Listens for `lnkdrp:out-of-credits` and shows a single modal across the app.
 * Includes a short cooldown to avoid repeated triggers spamming the user.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import OutOfCreditsModal from "@/components/OutOfCreditsModal";
import { OUT_OF_CREDITS_EVENT } from "@/lib/client/outOfCredits";

const COOLDOWN_MS = 8_000;

export default function OutOfCreditsListener() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const lastShownAtRef = useRef(0);

  useEffect(() => {
    function onOutOfCredits() {
      if (open) return;
      const now = Date.now();
      if (now - lastShownAtRef.current < COOLDOWN_MS) return;
      lastShownAtRef.current = now;
      setOpen(true);
    }

    window.addEventListener(OUT_OF_CREDITS_EVENT, onOutOfCredits);
    return () => window.removeEventListener(OUT_OF_CREDITS_EVENT, onOutOfCredits);
  }, [open]);

  return (
    <OutOfCreditsModal
      open={open}
      onClose={() => setOpen(false)}
      onManageCredits={() => {
        setOpen(false);
        router.push("/dashboard/limits");
      }}
    />
  );
}


