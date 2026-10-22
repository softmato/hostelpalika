import { describe, expect, it } from "vitest";

import { bumpHostelCache, cachedRead } from "@/lib/redis-cache";

// No UPSTASH_* env in tests: the cache must be invisible, never an error.
describe("redis-cache without Redis", () => {
  const principal = { hostelIds: ["h1"], userId: "u1" };

  it("reads straight from the loader", async () => {
    await expect(cachedRead(principal, "k", async () => ({ rows: 3 }))).resolves.toEqual({ rows: 3 });
  });

  it("passes loader errors through unchanged", async () => {
    await expect(cachedRead(principal, "k", async () => Promise.reject(new Error("db down")))).rejects.toThrow("db down");
  });

  it("bumps without throwing", async () => {
    await expect(bumpHostelCache(["h1", null, undefined])).resolves.toBeUndefined();
  });
});
