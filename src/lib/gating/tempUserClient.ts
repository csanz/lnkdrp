export const TEMP_USER_STORAGE_KEY = "lnkdrp_temp_user";

export type TempUserStored = { id: string; secret: string };

function isBrowser() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

export function getTempUser(): TempUserStored | null {
  if (!isBrowser()) return null;
  try {
    const raw = window.localStorage.getItem(TEMP_USER_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const id = (parsed as { id?: unknown }).id;
    const secret = (parsed as { secret?: unknown }).secret;
    if (typeof id !== "string" || !id) return null;
    if (typeof secret !== "string" || !secret) return null;
    return { id, secret };
  } catch {
    return null;
  }
}

export function setTempUser(next: TempUserStored) {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(TEMP_USER_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore storage failures
  }
}

export function clearTempUser() {
  if (!isBrowser()) return;
  try {
    window.localStorage.removeItem(TEMP_USER_STORAGE_KEY);
  } catch {
    // ignore
  }
}

function normalizeHeaders(h: HeadersInit | undefined): Headers {
  if (h instanceof Headers) return new Headers(h);
  return new Headers(h ?? undefined);
}

export function withTempUserHeaders(init?: RequestInit): RequestInit {
  const tu = getTempUser();
  if (!tu) return init ?? {};

  const headers = normalizeHeaders(init?.headers);
  // Do not overwrite if caller already set them explicitly.
  if (!headers.has("x-temp-user-id")) headers.set("x-temp-user-id", tu.id);
  if (!headers.has("x-temp-user-secret")) headers.set("x-temp-user-secret", tu.secret);

  return { ...(init ?? {}), headers };
}

export function captureTempUserFromResponse(res: Response) {
  if (!isBrowser()) return;
  const id = res.headers.get("x-temp-user-id");
  const secret = res.headers.get("x-temp-user-secret");
  if (id && secret) setTempUser({ id, secret });
}

export async function fetchWithTempUser(input: RequestInfo | URL, init?: RequestInit) {
  const res = await fetch(input, withTempUserHeaders(init));
  captureTempUserFromResponse(res);
  return res;
}



