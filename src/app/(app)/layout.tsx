"use client";

import { useMemo } from "react";
import { usePathname, useRouter } from "next/navigation";
import LeftSidebar from "@/components/LeftSidebar";
import { usePendingUpload } from "@/lib/pendingUpload";

export default function AppShellLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const { setPendingFile } = usePendingUpload();

  // Keep `/doc/:id/review` full-width (no sidebar), matching previous behavior.
  const hideSidebar = useMemo(
    () => pathname.includes("/review") || pathname.startsWith("/invitecodes"),
    [pathname],
  );

  if (hideSidebar) return <>{children}</>;

  return (
    <div className="flex h-[100svh] w-full bg-[var(--bg)] text-[var(--fg)]">
      <LeftSidebar
        onAddNewFile={(file) => {
          setPendingFile(file);
          router.push("/");
        }}
      />
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}



