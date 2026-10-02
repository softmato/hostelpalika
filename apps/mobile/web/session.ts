import type { StoredTokens } from "../src/lib/session";
const KEY = "hostelpalika_session";
export const SECURE_KEYS = { ACCESS_TOKEN: "hh_access_token", REFRESH_TOKEN: "hh_refresh_token" } as const;
export async function readTokens(): Promise<StoredTokens | null> {
  const saved = localStorage.getItem(KEY);
  if (saved) {
    try {
      const value = JSON.parse(saved);
      return typeof value.accessToken === "string" && typeof value.refreshToken === "string" ? value : null;
    } catch { return null; }
  }
  const accessToken = localStorage.getItem(SECURE_KEYS.ACCESS_TOKEN);
  const refreshToken = localStorage.getItem(SECURE_KEYS.REFRESH_TOKEN);
  if (!accessToken || !refreshToken) return null;
  const tokens = { accessToken, refreshToken };
  await writeTokens(tokens);
  return tokens;
}
export async function writeTokens(tokens: StoredTokens) {
  localStorage.setItem(KEY, JSON.stringify(tokens));
  localStorage.removeItem(SECURE_KEYS.ACCESS_TOKEN);
  localStorage.removeItem(SECURE_KEYS.REFRESH_TOKEN);
}
export async function writeAccessToken(accessToken: string) {
  const tokens = await readTokens();
  if (tokens) await writeTokens({ ...tokens, accessToken });
}
export async function clearTokens() {
  localStorage.removeItem(KEY);
  localStorage.removeItem(SECURE_KEYS.ACCESS_TOKEN);
  localStorage.removeItem(SECURE_KEYS.REFRESH_TOKEN);
}
