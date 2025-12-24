/**
 * Small time helpers for Node scripts.
 */

/**
 * ISO timestamp safe for pathnames/URLs (no ":" or ".").
 */
export function safeTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}



