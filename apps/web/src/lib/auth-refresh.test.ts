import { afterEach, beforeEach, expect, it, vi } from "vitest";
beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());
it("shares one refresh across concurrent callers", async () => {
 const fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 })); vi.stubGlobal("fetch", fetch);
 const { refreshSession } = await import("./auth-refresh");
 await expect(Promise.all([refreshSession(), refreshSession()])).resolves.toEqual([true, true]);
 expect(fetch).toHaveBeenCalledOnce();
});
it.each([429, 500, 503])("keeps transient %s separate from logout", async (status) => {
 vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status })));
 const { refreshSession } = await import("./auth-refresh");
 await expect(refreshSession()).rejects.toThrow();
});
it("reports rejected credentials", async () => {
 vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 401 })));
 const { refreshSession } = await import("./auth-refresh");
 await expect(refreshSession()).resolves.toBe(false);
});
