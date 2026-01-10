import { cn } from "@/lib/cn";

export type SelectProps = Omit<React.ComponentPropsWithoutRef<"select">, "size"> & {
  variant?: "panel" | "panel2";
  size?: "md";
};

export default function Select({ variant = "panel2", size = "md", className, ...props }: SelectProps) {
  return (
    <select
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


