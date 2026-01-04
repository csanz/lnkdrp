import { cn } from "@/lib/cn";

export type InputProps = React.ComponentPropsWithoutRef<"input"> & {
  variant?: "panel" | "panel2";
  size?: "md";
};

export default function Input({ variant = "panel", size = "md", className, ...props }: InputProps) {
  return (
    <input
      className={cn(
        "rounded-xl border border-[var(--border)] px-3 py-2 text-sm text-[var(--fg)]",
        variant === "panel" ? "bg-[var(--panel)]" : "bg-[var(--panel-2)]",
        size === "md" && "",
        className,
      )}
      {...props}
    />
  );
}


