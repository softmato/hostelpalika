import { describe, expect, it } from "vitest";

import { filterRows, NO_FILTER, type StatementRow, withBalances } from "@/lib/statement";

const row = (id: string, kind: StatementRow["kind"], amount: number, at: string | null): StatementRow => ({
  amount,
  at,
  facts: [],
  id,
  kind,
  method: "CASH",
  title: id,
});

describe("statement rows", () => {
  it("counts the balance oldest first from the opening, moves not counted, undated last", () => {
    const rows = withBalances(
      [
        row("rent", "in", 10_000, "2026-10-01T05:00:00Z"),
        row("salary", "out", 4_000, "2026-10-03T05:00:00Z"),
        row("to-warden", "move", 2_000, "2026-10-04T05:00:00Z"),
        row("lost", "in", 500, null),
      ],
      1_000,
    );

    expect(rows.map((item) => [item.id, item.balance])).toEqual([
      ["to-warden", 7_000],
      ["salary", 7_000],
      ["rent", 11_000],
      ["lost", null],
    ]);
  });

  it("filters by direction, Nepal day range and minimum amount", () => {
    const rows = [row("a", "in", 100, "2026-10-01T20:00:00Z"), row("b", "out", 900, "2026-10-02T05:00:00Z")];

    // 20:00 UTC on the 1st is already the 2nd in Nepal.
    expect(filterRows(rows, { ...NO_FILTER, from: "2026-10-02" }).map((item) => item.id)).toEqual(["a", "b"]);
    expect(filterRows(rows, { ...NO_FILTER, direction: "out" }).map((item) => item.id)).toEqual(["b"]);
    expect(filterRows(rows, { ...NO_FILTER, min: "500" }).map((item) => item.id)).toEqual(["b"]);
  });
});
