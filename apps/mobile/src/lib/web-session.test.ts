import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { readTokens, writeTokens, clearTokens } from "../../web/session";
beforeEach(() => {
 const values = new Map<string, string>();
 vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null,
   setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
});
afterEach(() => vi.unstubAllGlobals());
it("migrates existing PWA credentials without losing the session", async () => {
 localStorage.setItem("hh_access_token", "access"); localStorage.setItem("hh_refresh_token", "refresh");
 expect(await readTokens()).toEqual({ accessToken: "access", refreshToken: "refresh" });
 expect(localStorage.getItem("hh_access_token")).toBeNull();
 expect(await readTokens()).toEqual({ accessToken: "access", refreshToken: "refresh" });
});
it("replaces and clears both credentials together", async () => {
 await writeTokens({ accessToken: "new", refreshToken: "rotated" });
 expect(await readTokens()).toEqual({ accessToken: "new", refreshToken: "rotated" });
 await clearTokens(); expect(await readTokens()).toBeNull();
});
