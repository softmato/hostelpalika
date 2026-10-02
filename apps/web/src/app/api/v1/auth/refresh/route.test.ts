import { NextRequest } from "next/server";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ refreshAccessToken: vi.fn(), logout: vi.fn(), AuthServiceError: class extends Error {} }));
vi.mock("@/modules/auth/auth.service", () => mocks);
import { POST } from "./route";
import { POST as logout } from "../logout/route";
beforeEach(() => { vi.clearAllMocks(); mocks.refreshAccessToken.mockResolvedValue({ accessToken: "new-access", refreshToken: "new-refresh", user: {} }); });
function request(mobile: boolean) {
 return new NextRequest("https://example.com/api/v1/auth/refresh", { method: "POST", headers: { "content-type": "application/json", cookie: "hostelpalika_refresh=website", ...(mobile ? { "x-hostelhub-client": "mobile" } : {}) }, body: JSON.stringify({ refreshToken: "app-token" }) });
}
it("refreshes the app token even when website cookies exist", async () => {
 const response = await POST(request(true));
 expect(mocks.refreshAccessToken).toHaveBeenCalledWith("app-token", { cookieSession: false });
 expect(response.headers.get("set-cookie")).toBeNull();
 expect((await response.json()).data.refreshToken).toBe("new-refresh");
});
it("keeps cookie refresh for ordinary website callers", async () => {
 const response = await POST(request(false));
 expect(mocks.refreshAccessToken).toHaveBeenCalledWith("website", { cookieSession: true });
 expect(response.headers.get("set-cookie")).toContain("hostelpalika_refresh");
});
it("logs out only the app session", async () => {
 const response = await logout(request(true));
 expect(mocks.logout).toHaveBeenCalledWith("app-token");
 expect(response.headers.get("set-cookie")).toBeNull();
});

it("retires the duplicate cookie issued by older app logins", async () => {
 const req = request(true); req.cookies.set("hostelpalika_refresh", "app-token");
 const response = await POST(req);
 expect(mocks.refreshAccessToken).toHaveBeenCalledWith("app-token", { cookieSession: false });
 expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
});
