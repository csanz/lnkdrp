/**
 * "Has this browser ever been signed in?" — one bit, kept client-side.
 *
 * `AuthGate` needs to tell two arrivals apart when it bounces someone to `/login`, and the session
 * itself cannot tell them apart: a cookie that expired and a cookie that never existed both read as
 * "no session".
 *
 * - **Signed out mid-use** — they had a session, it ended. They deserve to be told that, and taken
 *   back to the page they were on.
 * - **A cold visit to a gated URL** — a bookmark, a shared link, a new device. Telling them they
 *   were "signed out" would be a small lie about something they never did.
 *
 * So the app writes this bit whenever a session is confirmed and clears it on a deliberate sign
 * out. It is `localStorage`, which is to say: advisory. Private windows, cleared site data and
 * storage exceptions all make it read `false`, and the only cost of that is a returning user
 * getting the plain sign-in page instead of the "you were signed out" one.
 */
const KEY = "ld_had_session";

/** Record that a session was live in this browser. Safe to call on every render. */
export function rememberSignedIn(): void {
  try {
    window.localStorage.setItem(KEY, "1");
  } catch {
    // Private window, blocked storage: the bit is a nicety, never a requirement.
  }
}

/** Forget it — on a deliberate sign out, so the next visit is not told it "was signed out". */
export function forgetSignedIn(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

/** True only when a session was confirmed here before and never deliberately ended. */
export function hadSession(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}
