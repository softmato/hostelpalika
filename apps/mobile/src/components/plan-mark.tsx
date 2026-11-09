import { View } from "react-native";

/**
 * The plan marks — the same drawing `/plans-pricing` puts on each plan card
 * (`apps/web/src/app/_components/plan-mark.tsx`), so the plan an owner bought
 * looks the same on their billing screen as it did on the page they chose it
 * from.
 *
 * One drawing in three states: a roof, and the residents under it. The roof
 * and all three rows sit at the same place in every mark — what changes is how
 * many rows are filled in, so Go, Pro and Max read as one house getting fuller.
 * Rows past the plan stay on the grid, faint, as headroom.
 *
 * ## Views, not SVG
 *
 * The web draws this as SVG on a 40×40 grid. This build has no SVG renderer,
 * and a roof plus six dots does not need one: each rafter is a rounded bar
 * rotated to the web path's pitch, and each dot is a circle, all laid out on the
 * same 40-unit grid and scaled to `size`. The coordinates below are the web
 * file's, so a change to one is a change to both.
 */

/** Rows fill downward from the roof, widening as they go. */
const ROWS: { cx: number[]; cy: number }[] = [
  { cx: [20], cy: 22 },
  { cx: [13, 27], cy: 29 },
  { cx: [6, 20, 34], cy: 36 },
];

const GRID = 40;
const STROKE = 1.8;
const DOT_RADIUS = 2.7;

/*
 * The web roof is `M4.5 15.5 L20 5.5 L35.5 15.5`: two rafters meeting at the
 * ridge. Each is drawn as a bar centred on its midpoint and rotated by the
 * pitch, and lengthened by one stroke so its round ends overlap at the ridge
 * the way `strokeLinecap="round"` does.
 */
const EAVE_Y = 15.5;
const RIDGE = { x: 20, y: 5.5 };
const RUN = RIDGE.x - 4.5;
const RISE = EAVE_Y - RIDGE.y;
const RAFTER = Math.hypot(RUN, RISE);
const PITCH = (Math.atan2(RISE, RUN) * 180) / Math.PI;

/** The free tier: two linked rings (∞) under the roof, as on the website. */
const FREE_RINGS = [14.5, 25.5];
const RING_R = 5.5;

export function PlanMark({
  color,
  free = false,
  rank,
  size = 28,
}: {
  /** Draw the free tier's rings instead of resident rows. */
  free?: boolean;
  /** A resolved colour — the tile's ink, usually `colors.primary`. */
  color: string;
  /** Cheapest-first position of the plan. Doubles as the fill depth. */
  rank: number;
  size?: number;
}) {
  const unit = size / GRID;
  const filledRows = Math.min(ROWS.length, Math.max(0, rank) + 1);
  const stroke = STROKE * unit;
  const length = (RAFTER + STROKE) * unit;
  const midY = ((EAVE_Y + RIDGE.y) / 2) * unit;

  return (
    <View accessible={false} style={{ height: size, width: size }}>
      {[-1, 1].map((side) => {
        const midX = (RIDGE.x + (side * RUN) / 2) * unit;

        return (
          <View
            key={side}
            style={{
              backgroundColor: color,
              borderRadius: stroke / 2,
              height: stroke,
              left: midX - length / 2,
              position: "absolute",
              top: midY - stroke / 2,
              // The left rafter climbs to the ridge, the right one falls away.
              transform: [{ rotate: `${side < 0 ? -PITCH : PITCH}deg` }],
              width: length,
            }}
          />
        );
      })}

      {free
        ? FREE_RINGS.map((cx) => (
            <View
              key={cx}
              style={{
                borderColor: color,
                borderRadius: RING_R * unit,
                borderWidth: stroke,
                height: RING_R * 2 * unit,
                left: (cx - RING_R) * unit,
                position: "absolute",
                top: (27 - RING_R) * unit,
                width: RING_R * 2 * unit,
              }}
            />
          ))
        : ROWS.map((row, index) =>
        row.cx.map((cx) => (
          <View
            key={`${cx}-${row.cy}`}
            style={{
              backgroundColor: color,
              borderRadius: DOT_RADIUS * unit,
              height: DOT_RADIUS * 2 * unit,
              left: (cx - DOT_RADIUS) * unit,
              // Rows past this plan stay on the grid as headroom, not capacity.
              opacity: index < filledRows ? 1 : 0.2,
              position: "absolute",
              top: (row.cy - DOT_RADIUS) * unit,
              width: DOT_RADIUS * 2 * unit,
            }}
          />
        )),
      )}
    </View>
  );
}
