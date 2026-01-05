import { cn } from "@/lib/cn";

export type DataTableProps = {
  /** Optional wrapper around the table for the common "card" + horizontal scroll pattern. */
  containerClassName?: string;
  /** Class applied to the scroll wrapper (usually `overflow-x-auto`). */
  scrollClassName?: string;
  /** Class applied to the `<table>` element. */
  tableClassName?: string;
  children: React.ReactNode;
};

export default function DataTable({ containerClassName, scrollClassName, tableClassName, children }: DataTableProps) {
  return (
    <div className={cn("overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)]", containerClassName)}>
      <div className={cn("overflow-x-auto", scrollClassName)}>
        <table className={cn("min-w-full text-left text-sm", tableClassName)}>{children}</table>
      </div>
    </div>
  );
}


