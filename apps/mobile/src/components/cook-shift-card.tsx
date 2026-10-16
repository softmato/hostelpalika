import { LinearGradient } from "expo-linear-gradient";
import { View } from "react-native";

import { FLOAT_SHADOW, usePortalPaint } from "@/components/portal-shared";
import { Glyph } from "@/components/ui/glyph";
import { Text } from "@/components/ui/text";

/**
 * The kitchen's shift, as one painted card: how many plates, and what is left
 * to call.
 *
 * ## Why the cook portal gets a painted lead at all
 *
 * Today opened with a plain bordered box holding `Cooking for` / `42` / a
 * sentence, under a 16-point app bar — while the admin, resident and guardian
 * homes all opened on paint. Four portals of one product, one of which looked
 * like a different app, and it is the one used by somebody standing over a pot
 * who needs to read it at arm's length.
 *
 * ## Its shape is the money card's, not the hero's
 *
 * Inset on all four sides, cornered at 26, floating on `FLOAT_SHADOW` — the
 * `<AdminMoneyCard>` / `<ResidentDuesCard>` geometry rather than
 * `<PortalHeroCard>`'s full-bleed 18. The full-bleed hero is a *front door*: it
 * names the app and the building, and it is right for a screen you land on and
 * look around. This screen is a **worktop**. Its four announce buttons are the
 * point of the portal and they start about 240 points down; a card that bleeds
 * to the edges reads as a surface the buttons sit on rather than as one object
 * above them.
 *
 * ## The figure is the head count, and it is the right one
 *
 * It is `residentCount` — the same number the announcement fan-out notifies, so
 * a cook reading "42" and a fan-out reaching 42 people are the same fact. It is
 * not a currency, so no `<PaintedAmount>`: that component exists to draw `NPR`
 * smaller than its digits, and there is no prefix here to shrink.
 *
 * ## The two-up says what is left, never a percentage
 *
 * `2 of 4 announced` and the next meal to call. Not "50% complete" — a shift is
 * four discrete acts, and a kitchen that has done breakfast and lunch at 2pm is
 * exactly on schedule rather than half-failing. The same reasoning
 * `app/attendance.tsx` records for refusing a presence percentage.
 */
export function CookShiftCard({
  announced,
  hostelName,
  nextLabel,
  nextTiming,
  residentCount,
}: {
  /** How many of the four meals have been called today. */
  announced: number;
  hostelName: string;
  /** The meal still to call — `Dinner` — or `null` once all four are out. */
  nextLabel: string | null;
  /** That meal's serving time off the routine, when the office set one. */
  nextTiming: string;
  residentCount: number;
}) {
  const paint = usePortalPaint();
  const done = nextLabel === null;

  return (
    <View className="px-5">
      <LinearGradient
        colors={[paint.from, paint.to]}
        end={{ x: 1, y: 1 }}
        start={{ x: 0, y: 0 }}
        style={[FLOAT_SHADOW, { borderRadius: 26, overflow: "hidden" }]}
      >
        {/*
          One disc, bled off the top-right — the same single ornament the other
          two inset cards carry. A card this size takes one before it stops
          reading as a card and starts reading as a pattern.
        */}
        <View className="absolute inset-0" style={{ pointerEvents: "none" }}>
          <View
            className="absolute rounded-full bg-white/10"
            style={{ height: 150, right: -55, top: -60, width: 150 }}
          />
        </View>

        <View className="gap-4 p-5">
          <View className="flex-row items-start justify-between gap-3">
            <View className="shrink gap-0.5">
              <Text
                className="font-semibold uppercase tracking-wider text-white/70"
                numberOfLines={1}
                style={{ fontSize: 10 }}
              >
                Cooking for
              </Text>

              <View className="flex-row items-baseline gap-2">
                {/*
                  Set in points rather than by a class, as every measured figure
                  in this app is: `variant="display"` is a themed token that
                  resolves to `text-foreground`, which is near-black on the paint
                  and would disappear. The `lineHeight` is not optional — an OEM
                  Android skin's display face runs past the metrics a 1.25
                  multiplier assumes and clips the tops of the digits.
                */}
                <Text
                  className="font-semibold tracking-tight text-white"
                  numberOfLines={1}
                  style={{ fontSize: 40, lineHeight: 50 }}
                >
                  {residentCount}
                </Text>
                <Text className="text-white/75" style={{ fontSize: 13 }}>
                  {residentCount === 1 ? "resident" : "residents"}
                </Text>
              </View>

              <Text className="text-white/70" numberOfLines={1} style={{ fontSize: 12 }}>
                {hostelName}
              </Text>
            </View>

            {/*
              The white pill on the shoulder, in the state that applies — the
              same slot the other two cards use for "overdue" and "to check".
              Its ink is a literal for the reason recorded on `<AdminMoneyCard>`:
              this pill is white-on-paint in **both** schemes, so a themed token
              would resolve to the dark-mode value on a card that never goes
              dark.
            */}
            <View className="flex-row items-center gap-1 rounded-full bg-white px-2.5 py-1">
              <Glyph
                color={done ? "#0a8a4b" : "#b45309"}
                name={done ? "checkmark-circle" : "time"}
                size={11}
              />
              <Text
                className={`font-bold ${done ? "text-[#0a8a4b]" : "text-[#b45309]"}`}
                numberOfLines={1}
                style={{ fontSize: 10 }}
              >
                {done ? "All called" : `${announced} of 4`}
              </Text>
            </View>
          </View>

          {/*
            Two figures split by a hairline, each on a fixed half of the row —
            `flex-1` on both and `numberOfLines={1}` on every line. Sizing them
            to their content is what `portal-shared.tsx` records as making every
            chip give up width to its neighbours until all of them ellipse.
          */}
          <View className="flex-row items-center gap-3 border-t border-white/20 pt-3.5">
            <ShiftFact
              label="Announced"
              note={announced === 4 ? "Nothing left to call" : "of four meals"}
              value={`${announced} of 4`}
            />
            <View className="h-8 w-px bg-white/20" />
            <ShiftFact
              label="Next to call"
              note={nextTiming || (done ? "The shift is done" : "No time set")}
              value={nextLabel ?? "—"}
            />
          </View>
        </View>
      </LinearGradient>
    </View>
  );
}

/** One half of the card's two-up: a small-caps name, a value, a quiet note. */
function ShiftFact({
  label,
  note,
  value,
}: {
  label: string;
  note: string;
  value: string;
}) {
  return (
    <View className="flex-1 gap-0.5">
      <Text
        className="font-semibold uppercase tracking-wider text-white/60"
        numberOfLines={1}
        style={{ fontSize: 9 }}
      >
        {label}
      </Text>
      <Text
        className="font-semibold text-white"
        numberOfLines={1}
        style={{ fontSize: 14 }}
      >
        {value}
      </Text>
      <Text className="text-white/70" numberOfLines={1} style={{ fontSize: 11 }}>
        {note}
      </Text>
    </View>
  );
}
