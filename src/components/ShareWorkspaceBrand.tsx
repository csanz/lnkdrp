import WorkspaceIcon from "@/components/WorkspaceIcon";
import { brandInitials, type ShareWorkspaceBrand as Brand } from "@/lib/share/brand";

/**
 * The sender's mark in a recipient-facing header: their workspace icon and name, next to ours.
 *
 * It sits *after* the LinkDrop logo with a hairline between them, and that order is the point. The
 * two marks are two different parties — the platform the link runs on, and the company that sent
 * it — and a recipient who cannot tell them apart is the failure mode this arrangement avoids. Ours
 * stays first and small; theirs is the one with a name beside it.
 *
 * The name is hidden below `sm` and the tile is not: on a phone the header also holds the viewer's
 * controls, and an icon that survives every width is worth more than a name that wraps at some.
 */
export default function ShareWorkspaceBrand({ brand }: { brand: Brand | null }) {
  if (!brand) return null;
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span aria-hidden="true" className="h-5 w-px shrink-0 bg-white/15" />
      <WorkspaceIcon
        avatarUrl={brand.avatarUrl}
        fallback={brandInitials(brand.name)}
        className="h-6 w-6 text-[10px]"
        fallbackClassName="bg-white/10 text-white/80"
      />
      <span className="min-w-0 truncate text-[13px] font-medium text-white/80 max-sm:hidden" title={brand.name}>
        {brand.name}
      </span>
    </div>
  );
}
