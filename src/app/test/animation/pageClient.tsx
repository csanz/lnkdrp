/**
 * AnimationTestClient
 *
 * Route: `/test/animation`
 * Purpose: Preview loading animations (dots vs spinner).
 */
"use client";

import { useState } from "react";
import DotsLoader from "@/components/ui/DotsLoader";
import Button from "@/components/ui/Button";
import SpinnerLoader from "@/components/ui/SpinnerLoader";

export default function AnimationTestClient() {
  const [mode, setMode] = useState<"dots" | "spinner">("spinner");
  return (
    <main className="min-h-[100svh] bg-[var(--bg)] text-[var(--fg)]">
      <div className="absolute left-1/2 top-6 -translate-x-1/2">
        <div className="flex items-center gap-2 rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-1">
          <Button
            variant={mode === "dots" ? "solid" : "ghost"}
            size="sm"
            className="rounded-xl"
            onClick={() => setMode("dots")}
          >
            Dots
          </Button>
          <Button
            variant={mode === "spinner" ? "solid" : "ghost"}
            size="sm"
            className="rounded-xl"
            onClick={() => setMode("spinner")}
          >
            Spinner
          </Button>
        </div>
      </div>

      {mode === "dots" ? (
        <DotsLoader title={null} />
      ) : (
        <SpinnerLoader title={null} />
      )}
    </main>
  );
}

