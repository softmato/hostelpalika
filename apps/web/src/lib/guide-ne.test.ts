import { describe, expect, it } from "vitest";

import { GUIDE_ACCESS, GUIDE_GROUPS, GUIDE_TROUBLE } from "@hostel/shared/guide/guide";
import { GUIDE_NE, GUIDE_NE_ACCESS, GUIDE_NE_GROUPS, GUIDE_NE_TROUBLE } from "@hostel/shared/guide/guide-ne";

/** A chapter changed in guide.ts without its Nepali shows mismatched lines under नेपाली. */
describe("Nepali guide matches the English one", () => {
  it("has every group and chapter, line for line", () => {
    for (const group of GUIDE_GROUPS) {
      expect(GUIDE_NE_GROUPS[group.slug], group.slug).toBeDefined();
      for (const c of group.chapters) {
        const ne = GUIDE_NE[c.id];
        expect(ne, c.id).toBeDefined();
        expect(ne.body?.length ?? 0, `${c.id} body`).toBe(c.body?.length ?? 0);
        expect(ne.steps?.length ?? 0, `${c.id} steps`).toBe(c.steps?.length ?? 0);
        expect(Boolean(ne.note), `${c.id} note`).toBe(Boolean(c.note));
        expect(Boolean(ne.flow), `${c.id} flow`).toBe(Boolean(c.flow));
        expect(Boolean(ne.shot), `${c.id} shot`).toBe(Boolean(c.shot));
      }
    }
  });

  it("covers the reference tables", () => {
    expect(GUIDE_NE_TROUBLE).toHaveLength(GUIDE_TROUBLE.length);
    for (const row of GUIDE_ACCESS) {
      expect(GUIDE_NE_ACCESS.areas[row.area], row.area).toBeDefined();
      for (const cell of Object.values(row.cells)) if (cell !== "—") expect(GUIDE_NE_ACCESS.cells[cell], cell).toBeDefined();
    }
  });
});
