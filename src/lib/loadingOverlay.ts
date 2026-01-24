/**
 * Loading overlay shared constants.
 *
 * Exists to keep the real client-side overlay (`SwitchingOverlay`) and the `/org/switch` fallback
 * HTML page visually in sync without updating multiple files for simple spacing tweaks.
 */

/**
 * Vertical gap (px) between the title text and the dots loader.
 */
export const LOADING_OVERLAY_TITLE_TO_DOTS_GAP_PX = 25;

/**
 * Whether to show the loading overlay title text by default.
 *
 * Exists so the real client overlay and `/org/switch` fallback can stay in sync.
 */
export const LOADING_OVERLAY_SHOW_TEXT_DEFAULT = false;

