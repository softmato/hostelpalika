import { cn } from "@/lib/utils";

/**
 * The plan marks.
 *
 * One drawing in three states rather than three unrelated icons: a roof, and
 * the residents under it. The roof and all three rows sit at the same place in
 * every mark — what changes is how many rows are filled in, so the three cards
 * read left to right as one house getting fuller, which is exactly what the
 * price is buying.
 *
 * Rows are fixed rather than added because a mark that grows also *moves*: draw
 * only the rows a plan has and Go becomes a small chevron floating in an empty
 * box while Max fills it, and the three cards stop lining up. Faint rows keep
 * every mark the same size and turn the empty space into headroom, which is
 * what the plan above is selling.
 *
 * Drawn on one 40×40 grid at one stroke weight in `currentColor`, so it takes
 * the card's own colour and stays sharp at any size. Deliberately not a
 * glyph — no stock icon says "more people under one roof".
 */

/** Rows fill downward from the roof, widening as they go. */
const ROWS: { cx: number[]; cy: number }[] = [
  { cx: [20], cy: 22 },
  { cx: [13, 27], cy: 29 },
  { cx: [6, 20, 34], cy: 36 },
];

const ROOF = "M4.5 15.5 L20 5.5 L35.5 15.5";

export function PlanMark({
  className,
  rank,
}: {
  className?: string;
  /** Cheapest-first position of the plan. Doubles as the fill depth. */
  rank: number;
}) {
  // Rank doubles as the fill depth: the entry plan fills one row, the next two,
  // the third all three. A catalogue with more tiers than rows keeps the mark
  // full rather than growing it — three rows is the drawing, not the count.
  const filledRows = Math.min(ROWS.length, rank + 1);

  return (
    <svg
      aria-hidden
      className={cn("size-7", className)}
      fill="none"
      viewBox="0 0 40 40"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d={ROOF}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.8}
      />
      {ROWS.map((row, index) =>
        row.cx.map((cx) => (
          <circle
            cx={cx}
            cy={row.cy}
            fill="currentColor"
            key={`${cx}-${row.cy}`}
            // Rows past this plan stay on the grid as headroom, not capacity.
            opacity={index < filledRows ? 1 : 0.2}
            r={2.7}
          />
        )),
      )}
    </svg>
  );
}
