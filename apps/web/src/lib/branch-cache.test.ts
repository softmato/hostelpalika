import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { BRANCH_STALE_MS, BRANCH_GC_MS, branchRequestOptions, branchSlug, portalResourceKey } from "./branch-cache";

describe("branch cache", () => {
  it("reuses each branch's data across A -> B -> A and refreshes invalidated data", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: BRANCH_STALE_MS, gcTime: BRANCH_GC_MS, retry: false } } });
    const a = vi.fn(async () => "A residents");
    const b = vi.fn(async () => "B residents");
    const keyA = portalResourceKey("/residents", "A");
    const keyB = portalResourceKey("/residents", "B");
    try {
      await client.fetchQuery({ queryKey: keyA, queryFn: a });
      await client.fetchQuery({ queryKey: keyB, queryFn: b });
      expect(await client.fetchQuery({ queryKey: keyA, queryFn: a })).toBe("A residents");
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
      await client.invalidateQueries({ queryKey: keyA });
      await client.fetchQuery({ queryKey: keyA, queryFn: a });
      expect(a).toHaveBeenCalledTimes(2);
      expect(client.getQueryData(keyB)).toBe("B residents");
    } finally { client.clear(); }
  });

  it("binds request headers to the key's branch, including URL-encoded slugs", () => {
    const slug = branchSlug("/my%20hostel/admin/dashboard");
    expect(portalResourceKey("/dashboard", slug)[2]).toBe(slug);
    expect(branchRequestOptions(slug).headers["x-hostel-id"]).toBe("my hostel");
    expect(branchSlug("/resident/dashboard")).toBe("");
  });
});
