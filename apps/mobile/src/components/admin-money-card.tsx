import { LinearGradient } from "expo-linear-gradient";
import { View } from "react-native";

import { FLOAT_SHADOW, PaintedAmount, usePortalPaint } from "@/components/portal-shared";
import { Glyph } from "@/components/ui/glyph";
import { Text } from "@/components/ui/text";
import { collectionRate } from "@/lib/admin-home";
import { formatMoney, heroAmountSize } from "@/lib/format";

/**
 * The month's collections, as a card object rather than as a painted band.
 *
 * ## Why this is not `AdminBanner`
 *
 * It was, and every admin tab then opened with the same full-bleed coloured
 * strip under the same painted bar — five screens whose top 200 points were
 * indistinguishable, which is a worse problem than the flat boxes it replaced.
 * Sameness at the top of a screen is not consistency, it is a failure to say
 * where you are.
 *
 * So the paint stays and the *shape* changes. Home's is a full-bleed hero with
 * the building behind it, because Home is the front door. This is a card —
 * inset from the page edge on all four sides, floating on the page background
 * with a shadow under it — because Money is a statement, and a statement is an
 * object you hold rather than a surface you stand on. They share their colours
 * and share nothing else.
 *
 * ## The meter is the whole reason this is not three numbers
 *
 * `NPR 74,000 of NPR 98,000` is two figures and a subtraction. The bar is the
 * answer the subtraction was for, and it is legible at arm's length. Its own
 * track is drawn here rather than reusing `<Meter>`: that component's tones are
 * palette colours for a themed surface, and `bg-destructive` on a teal card is
 * a red smear rather than a warning.
 */
export function AdminMoneyCard({
  billed,
  collected,
  month,
  proofs,
}: {
  billed: number;
  collected: number;
  /** `2026-08`, as the invoice matrix reports it. */
  month: string;
  /** Claims still waiting on a person — the one live thing on the card. */
  proofs: number;
}) {
  const paint = usePortalPaint();

  const amount = formatMoney(collected);
  const percent = collectionRate(collected, billed);
  const shortfall = Math.max(0, billed - collected);

  return (
    <View className="px-5">
      <LinearGradient
        colors={[paint.from, paint.to]}
        end={{ x: 1, y: 1 }}
        start={{ x: 0, y: 0 }}
        style={[FLOAT_SHADOW, { borderRadius: 26, overflow: "hidden" }]}
      >
        {/*
          One disc, bled off the top-right. Home's hero has two and a
          photograph; a card this size takes one before it stops reading as a
          card and starts reading as a pattern.
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
                Collected in {month}
              </Text>

              {/*
                Sized from the string, with `NPR` drawn smaller than its digits
                and the `lineHeight` Android needs at this size — both of which
                `PaintedAmount` owns, so this card and Home's hero cannot end up
                rendering the same amount two different ways.
              */}
              <PaintedAmount size={heroAmountSize(amount)} value={amount} />
            </View>

            {proofs > 0 ? (
              <View className="flex-row items-center gap-1 rounded-full bg-white px-2.5 py-1">
                <Glyph color="#b45309" name="time" size={11} />
                <Text
                  className="font-bold text-[#b45309]"
                  numberOfLines={1}
                  style={{ fontSize: 10 }}
                >
                  {proofs} to check
                </Text>
              </View>
            ) : null}
          </View>

          <View className="gap-1.5">
            <View className="h-2 w-full overflow-hidden rounded-full bg-white/20">
              {percent === null ? null : (
                <View
                  className="h-full rounded-full bg-white"
                  // A floor of 4% so a hostel that has collected something never
                  // reads as a completely empty track.
                  style={{ width: `${Math.max(percent > 0 ? 4 : 0, percent)}%` }}
                />
              )}
            </View>

            <Text className="text-white/75" style={{ fontSize: 11 }}>
              {percent === null
                ? "Nothing has been billed for this month yet"
                : `${percent}% of this month's bills have been paid`}
            </Text>
          </View>

          {/*
            Two halves with a hairline, each a fixed width. Sized-to-content
            chips were what the first cut used and they truncate: in a wrapping
            row every chip gives up width to its neighbours until each one
            ellipses, so the figures the card exists to show are the first thing
            lost. This is also the constraint the payments-UI literature keeps
            naming — stop a large currency amount from pushing what is beside it
            off the screen.
          */}
          <View className="flex-row items-center rounded-2xl border border-white/20 bg-white/10 px-3.5 py-2.5">
            {[
              { label: "Billed", value: formatMoney(billed) },
              { label: "Still to collect", value: formatMoney(shortfall) },
            ].map((fact, index) => (
              <View className="flex-1 flex-row items-center" key={fact.label}>
                {index > 0 ? <View className="mr-3.5 h-7 w-px bg-white/25" /> : null}

                <View className="flex-1">
                  <Text
                    className="font-semibold uppercase tracking-wider text-white/70"
                    numberOfLines={1}
                    style={{ fontSize: 9 }}
                  >
                    {fact.label}
                  </Text>
                  <PaintedAmount size={15} value={fact.value} />
                </View>
              </View>
            ))}
          </View>
        </View>
      </LinearGradient>
    </View>
  );
}
