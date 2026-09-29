import { describe, expect, it } from "vitest";

import {
  DEFAULT_MINIMUM_CHARGE,
  operationsConfigSchema,
} from "@/modules/platform-config/operations-config";

/**
 * The call-out charge rules, as validation.
 *
 * The charges are the platform's, in operations config. What is worth asserting
 * is that every trade always has a figure — a missing one must read as the
 * default, never as free — and the shapes a superadmin save refuses.
 */
const charges = (input?: unknown) =>
  operationsConfigSchema.parse(input === undefined ? {} : { maintenanceMinimumCharges: input })
    .maintenanceMinimumCharges;

describe("maintenanceMinimumCharges", () => {
  it("gives all eleven trades the default when nothing is stored", () => {
    const result = charges();

    expect(Object.keys(result)).toHaveLength(11);
    expect(Object.values(result).every((amount) => amount === DEFAULT_MINIMUM_CHARGE)).toBe(true);
  });

  it("fills a trade left out with the default, not zero", () => {
    const result = charges({ PLUMBING: 800 });

    expect(result.PLUMBING).toBe(800);
    expect(result.ELECTRICAL).toBe(DEFAULT_MINIMUM_CHARGE);
  });

  it("keeps a typed zero — a free call-out is a real statement", () => {
    expect(charges({ CLEANING: 0 }).CLEANING).toBe(0);
  });

  it("refuses paisa and negatives", () => {
    expect(() => charges({ PLUMBING: 800.5 })).toThrow();
    expect(() => charges({ PLUMBING: -1 })).toThrow();
  });

  it("drops a trade nobody defined", () => {
    expect(charges({ TELEPATHY: 500 })).not.toHaveProperty("TELEPATHY");
  });
});
