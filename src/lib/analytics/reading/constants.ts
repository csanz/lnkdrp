/**
 * Thresholds for document reading analytics. Every figure the metrics page and reader sheet show is
 * derived with these, so the page table, matrix, attention card and person view always agree.
 */
export const READ_MIN_MS = 2000;
export const STOP_CAP_MS = 600_000;
export const ACTIVE_WINDOW_MS = 600_000;
export const NOT_OPENED_AFTER_MS = 48 * 3_600_000;
export const RETURN_GAP_MS = 12 * 3_600_000;
export const HOT_READ_RATIO = 0.8;          // stayed pages / P
export const HOT_DWELL_MULTIPLIER = 2;
export const HOT_DWELL_MIN_PEERS = 3;       // other people with >=1 stayed page
export const TYPICAL_MIN_READERS = 3;       // page typicalMs shown only at readCount >= 3
export const CALLOUT_MIN_PEOPLE = 5;
export const CALLOUT_MIN_COUNT = 2;
export const MATRIX_ROW_LIMIT = 25;
export const MATRIX_ALL_LIMIT = 500;
export const ATTENTION_MAX_ROWS = 5;
export const VERDICT_LONGEST_MIN_MS = 20_000;
export const VERDICT_READ_MEDIAN_MS = 10_000;
export const PERSON_VISITS_LIMIT = 50;
export const MAX_VISITS_LOADED = 20_000;
export const ALLOWED_DAYS = [7, 30, 90, 365] as const;
