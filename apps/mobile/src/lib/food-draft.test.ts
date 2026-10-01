import { describe, expect, it } from "vitest";

import { cellKey, copyMeals, draftFrom, foodPayload } from "@/lib/food-draft";

const week = () => ({
  ...draftFrom(null),
  meals: {
    [cellKey("SUNDAY", "LUNCH")]: { items: "Dal, bhat , ,tarkari", note: " Veg table " },
    [cellKey("MONDAY", "LUNCH")]: { items: "Momo", note: "" },
    [cellKey("MONDAY", "DINNER")]: { items: "Roti", note: "" },
  },
});

describe("copyMeals", () => {
  it("replaces every meal of the picked days, empty ones included", () => {
    const copied = copyMeals(week(), "SUNDAY", ["MONDAY", "SUNDAY"]);

    expect(copied.meals[cellKey("MONDAY", "LUNCH")]).toEqual({ items: "Dal, bhat , ,tarkari", note: " Veg table " });
    expect(copied.meals[cellKey("MONDAY", "DINNER")]).toEqual({ items: "", note: "" });
    // The source day is never a target of itself.
    expect(copied.meals[cellKey("SUNDAY", "DINNER")]).toBeUndefined();
  });

  it("copies one meal only when asked, and leaves the draft it came from alone", () => {
    const draft = week();
    const copied = copyMeals(draft, "SUNDAY", ["MONDAY"], "LUNCH");

    expect(copied.meals[cellKey("MONDAY", "DINNER")]).toEqual({ items: "Roti", note: "" });
    expect(draft.meals[cellKey("MONDAY", "LUNCH")]).toEqual({ items: "Momo", note: "" });
  });
});

describe("foodPayload", () => {
  it("sends trimmed items, drops empty meals and keeps every timing key", () => {
    const payload = foodPayload(copyMeals(week(), "SUNDAY", ["MONDAY"]));

    expect(payload.meals).toEqual([
      { dayOfWeek: "SUNDAY", items: ["Dal", "bhat", "tarkari"], mealType: "LUNCH", note: "Veg table" },
      { dayOfWeek: "MONDAY", items: ["Dal", "bhat", "tarkari"], mealType: "LUNCH", note: "Veg table" },
    ]);
    expect(Object.keys(payload.timings)).toEqual(["BREAKFAST", "LUNCH", "SNACKS", "DINNER"]);
    expect(payload.monthEndSpecial).toEqual({ items: [], note: undefined });
  });
});
