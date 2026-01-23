import { cn } from "@/lib/cn";

export type InputProps = Omit<React.ComponentPropsWithoutRef<"input">, "size"> & {
  variant?: "panel" | "panel2";
  size?: "md";
};

/**
 * Styled input primitive used across app forms.
 *
 * Exists to standardize base Tailwind styles and theming tokens for inputs.
 * Side effects: none; forwards all props to the underlying `<input>`.
 */
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


