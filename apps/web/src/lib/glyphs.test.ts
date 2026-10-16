import { describe, expect, it } from "vitest";

import { GLYPHS, resolveGlyph, SOLID_GLYPHS } from "@hostel/shared/constants/glyphs";

describe("glyph set", () => {
  it("resolves names that came from data", () => {
    expect(resolveGlyph("bed")).toBe("bed");
    // Rows written before the swap still carry the Ionicons spelling.
    expect(resolveGlyph("bed-outline")).toBe("bed");
    expect(resolveGlyph("no-such-icon")).toBe("ellipse");
  });

  it("draws every solid glyph in line too", () => {
    for (const name of Object.keys(SOLID_GLYPHS)) expect(GLYPHS).toHaveProperty(name);
  });
});
