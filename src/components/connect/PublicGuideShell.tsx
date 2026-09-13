import type { ReactNode } from "react";

import PublicFooter from "@/components/PublicFooter";
import PublicHeader from "@/components/PublicHeader";
import { PUBLIC_DARK_TOKENS } from "@/components/connect/publicTokens";

/**
 * Chrome for the public MCP guides: the same dark ground, soft lighting, header and footer as
 * `/about` and `/pricing`, with the app tokens pinned to dark so the shared Connect components
 * (code blocks, tool table) render correctly regardless of the visitor's theme.
 */
export default function PublicGuideShell({ children }: { children: ReactNode }) {
  return (
    <main className="relative min-h-[100svh] w-full overflow-hidden bg-[#050506] text-white">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(1200px 700px at 80% 20%, rgba(255,255,255,0.10), rgba(255,255,255,0) 60%), radial-gradient(900px 500px at 20% 60%, rgba(255,255,255,0.06), rgba(255,255,255,0) 55%), radial-gradient(700px 500px at 60% 85%, rgba(255,255,255,0.05), rgba(255,255,255,0) 60%)",
        }}
      />
      <div className="relative z-10 flex min-h-[100svh] w-full flex-col">
        <PublicHeader />
        <div className="mx-auto w-full max-w-3xl flex-1 px-6 pb-16 pt-12 md:pt-16" style={PUBLIC_DARK_TOKENS}>
          {children}
        </div>
        <PublicFooter className="relative pb-6" containerClassName="mx-auto w-full max-w-3xl px-6" />
      </div>
    </main>
  );
}
