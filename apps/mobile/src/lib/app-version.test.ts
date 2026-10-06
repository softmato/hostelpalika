import { describe, expect, it } from "vitest";

import { isNewerVersion } from "@/lib/app-version";

describe("isNewerVersion", () => {
  it("compares part by part, not as text", () => {
    expect(isNewerVersion("1.10.0", "1.9.2")).toBe(true);
    expect(isNewerVersion("0.2", "0.1.9")).toBe(true);
    expect(isNewerVersion("0.1.0", "0.1.0")).toBe(false);
    expect(isNewerVersion("0.1.0", "0.2.0")).toBe(false);
    expect(isNewerVersion("1.0.0", null)).toBe(false);
  });
});
