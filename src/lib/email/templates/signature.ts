/** The sign-off every lnkdrp email ends with, so one change covers them all. */
export const EMAIL_SIGNATURE = "- LinkDrop";

/** Join body lines, dropping empties, and end with the signature. */
export function emailBody(lines: (string | null | undefined | false)[]): string {
  return [...lines, "", EMAIL_SIGNATURE].filter((l): l is string => typeof l === "string" && l !== undefined).join("\n");
}
