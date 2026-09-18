/**
 * Shared admin UI. Import from here, not from the individual files.
 *
 *   import { AdminPageHeader, AdminFilterBar, AdminTable, AdminTh, AdminTr, AdminTd } from "@/components/admin";
 *
 * The rules these enforce live in `src/lib/admin/ui.ts`.
 */
export { default as AdminPageHeader } from "./AdminPageHeader";
export type { AdminPageHeaderProps } from "./AdminPageHeader";

export { default as AdminSection } from "./AdminSection";
export type { AdminSectionProps } from "./AdminSection";

export { default as AdminAlert } from "./AdminAlert";
export type { AdminAlertProps } from "./AdminAlert";

export { default as AdminAccessState } from "./AdminAccessState";
export type { AdminAccessStateProps } from "./AdminAccessState";

/** Re-exported so a page needs one import to gate itself and to render the gate. */
export { useAdminAccess } from "@/lib/admin/useAdminAccess";
export type { AdminAccess } from "@/lib/admin/useAdminAccess";

export { default as AdminFilterBar } from "./AdminFilterBar";
export type { AdminFilterBarProps } from "./AdminFilterBar";

export { default as AdminSearchInput } from "./AdminSearchInput";
export type { AdminSearchInputProps } from "./AdminSearchInput";

export { default as AdminSelect } from "./AdminSelect";
export type { AdminSelectProps } from "./AdminSelect";

export { default as AdminTable, AdminTh, AdminTr, AdminTd, AdminTableEmpty, AdminTableMessage } from "./AdminTable";
export type { AdminTableProps, AdminThProps, AdminTrProps, AdminTdProps } from "./AdminTable";

export { default as StatusPill, BoolState } from "./StatusPill";
export type { StatusPillProps, BoolStateProps } from "./StatusPill";

export { default as IdCell } from "./IdCell";
export type { IdCellProps } from "./IdCell";

export { default as RowActions, RowAction, RowActionLink } from "./RowActions";
export type { RowActionsProps, RowActionProps, RowActionLinkProps } from "./RowActions";

export { default as SegmentedAction } from "./SegmentedAction";
export type { SegmentedActionProps, SegmentedOption } from "./SegmentedAction";

export { default as TimeCell } from "./TimeCell";
export type { TimeCellProps } from "./TimeCell";

export { default as DetailPanel, DetailGrid, DetailRow, DetailSection, StatTile, JsonBlock } from "./AdminDetail";
export type {
  DetailPanelProps,
  DetailGridProps,
  DetailRowProps,
  DetailSectionProps,
  StatTileProps,
  JsonBlockProps,
} from "./AdminDetail";

export { default as RevenueChart } from "./RevenueChart";
export { default as AdminTrendChart } from "./AdminTrendChart";
export type { TrendPoint, TrendMetric } from "./AdminTrendChart";
