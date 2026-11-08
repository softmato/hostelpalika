import { describe, expect, it } from "vitest";

import {
  agreementRef,
  blankLine,
  holdersOf,
  placesOf,
  readLines,
  withRefPreview,
  type SheetLine,
} from "@/lib/team/registration-track-sheet";

function typed(cells: Partial<SheetLine["cells"]>, id?: string): SheetLine {
  const line = blankLine(new Date("2026-09-21T06:00:00Z"));

  return { ...line, cells: { ...line.cells, ...cells }, ...(id ? { id, key: id } : {}) };
}

describe("agreementRef", () => {
  it("pads the number to three digits and keeps counting past 999", () => {
    const now = new Date("2026-09-21T06:00:00Z");

    expect(agreementRef(1, now)).toBe("SMT/HP/2026/001");
    expect(agreementRef(42, now)).toBe("SMT/HP/2026/042");
    expect(agreementRef(1000, now)).toBe("SMT/HP/2026/1000");
  });

  it("takes the year from the Nepal day, not UTC", () => {
    // 00:15 on 1 January in Kathmandu.
    expect(agreementRef(7, new Date("2026-12-31T18:30:00Z"))).toBe("SMT/HP/2027/007");
  });
});

describe("withRefPreview", () => {
  it("numbers typed new lines in order and the empty line only under the cursor", () => {
    const saved = typed({ hostelName: "Everest", refCode: "SMT/HP/2026/004" }, "a".repeat(24));
    const first = typed({ hostelName: "Annapurna" });
    const empty = typed({});
    const second = typed({ ownerName: "Ram" });

    const shown = withRefPreview([saved, first, empty, second], 5, new Set()).map((line) => line.cells.refCode);

    expect(shown).toEqual(["SMT/HP/2026/004", expect.stringMatching(/\/005$/), "", expect.stringMatching(/\/006$/)]);
    expect(withRefPreview([empty], 5, new Set([empty.key]))[0]!.cells.refCode).toMatch(/\/005$/);
  });
});

describe("placesOf", () => {
  it("names saved lines by id and new ones by their order under them", () => {
    const saved = typed({ hostelName: "Everest" }, "b".repeat(24));

    expect([...placesOf([saved, typed({}), typed({ hostelName: "X" })]).values()]).toEqual([
      "b".repeat(24),
      "new-0",
      "new-1",
    ]);
  });
});

describe("holdersOf", () => {
  const asha = { at: 100, line: "new-0", name: "Asha" };

  it("gives the line to whoever got there first", () => {
    // I came after Asha: she has it.
    expect(holdersOf("new-0", [asha], { at: 200, line: "new-0" })).toEqual(["Asha"]);
    // I was there first: I keep typing while she reads.
    expect(holdersOf("new-0", [asha], { at: 50, line: "new-0" })).toEqual([]);
    // Not on it, or my arrival not confirmed yet: hers.
    expect(holdersOf("new-0", [asha], null)).toEqual(["Asha"]);
    expect(holdersOf("new-0", [asha], { at: 50, line: "new-1" })).toEqual(["Asha"]);
  });
});

describe("readLines", () => {
  it("sends only changed, non-empty lines and stops on a missing name or a bad date", () => {
    const good = typed({ hostelName: "Everest", signedOn: "2083-06-05" });
    const noName = typed({ ownerName: "Sita" });
    const badDate = typed({ hostelName: "Machhapuchhre", signedOn: "soon" });
    const untouched = typed({ hostelName: "Not changed" });
    const empty = typed({});

    const read = readLines(
      [good, noName, badDate, untouched, empty],
      new Set([good.key, noName.key, badDate.key, empty.key]),
    );

    expect(read.rows.map((row) => row.hostelName)).toEqual(["Everest", "", "Machhapuchhre"]);
    expect(read.rows[0]!.signedOn.toISOString()).toBe("2026-09-21T00:00:00.000Z");
    expect(read.errors).toEqual([
      { column: "hostelName", key: noName.key, message: "Write the hostel name." },
      { column: "signedOn", key: badDate.key, message: "Write the Nepali date like 2083-06-05." },
    ]);
  });
});
