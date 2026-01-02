/**
 * Shared temp-user header names.
 *
 * These headers identify a lightweight "temp user" actor for gated flows (share/request)
 * without requiring full authentication.
 *
 * Kept in a separate module so both server and client code can import the same constants.
 */
export const TEMP_USER_ID_HEADER = "x-temp-user-id";
export const TEMP_USER_SECRET_HEADER = "x-temp-user-secret";




