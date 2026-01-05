import { cn } from "@/lib/cn";

export type PanelProps = React.ComponentPropsWithoutRef<"div"> & {
  variant?: "panel" | "panel2";
  padding?: "none" | "sm" | "md" | "lg";
  rounded?: "xl" | "2xl";
};

export default function Panel({
  variant = "panel",
  padding = "md",
  rounded = "2xl",
  className,
  ...props
}: PanelProps) {
  return (
    <div
      className={cn(
        rounded === "2xl" ? "rounded-2xl" : "rounded-xl",
        "border border-[var(--border)]",
        variant === "panel" ? "bg-[var(--panel)]" : "bg-[var(--panel-2)]",
        padding === "none" ? "p-0" : padding === "sm" ? "p-3" : padding === "lg" ? "p-6" : "p-5",
        className,
      )}
      {...props}
    />
  );
}


