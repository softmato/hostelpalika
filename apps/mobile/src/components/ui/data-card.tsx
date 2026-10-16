import type { ReactNode } from "react";
import { Pressable, View } from "react-native";

import { Glyph } from "@/components/ui/glyph";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";

/**
 * A subject, its figures, how far along it is, and one line of context.
 *
 * ## The shape it replaces
 *
 * The admin screens' money and occupancy blocks were a `<Card>` holding a big
 * number, a hairline, a bar, another hairline and a two-up row of small numbers
 * — correct, and read top-to-bottom like a form. What a hostel owner wants from
 * a card like this is a *glance*: the thing, its three numbers side by side so
 * they can be compared without scrolling, and a bar that says how far along it
 * is. Stacking those vertically is what made the old card take half a screen to
 * say four things.
 *
 * So the anatomy is fixed and the call site fills slots:
 *
 *     title                                   action
 *     meta
 *
 *     LABEL         LABEL          LABEL      <- stats, 2-3 equal columns
 *     value         value          value
 *
 *     [####][######][................]        <- one track, split
 *     left            ( pill )       right    <- footer
 *
 * Every region is optional except the title and the stats. A card with no
 * `segments` is a figure card; one with no `footer` simply ends at the track.
 *
 * ## The track is one bar, not three
 *
 * The reference this is modelled on draws what looks like three bars in a row.
 * They are three *parts of the same whole* — and drawing them as separate tracks
 * is how a reader ends up thinking each is its own 0-100%. Here the row is a
 * single track that has been split: each segment's width is its share of
 * `total`, and whatever is unclaimed stays as muted ground on the right. That
 * makes "we are two-thirds of the way there" readable without a legend, and it
 * makes an empty card look like an empty track rather than like three empty
 * bars.
 *
 * ## Zero and null are different, and the difference matters
 *
 * A `total` of `0` is *not* a card at 0% — it is a card with no denominator, and
 * a hostel that has billed nothing this month reading an empty red bar concludes
 * it has collected nothing, which is a different and much worse claim. That case
 * draws the muted track alone and leaves the explaining to the caller's footer,
 * exactly as `<Meter>` does. The two components agree on this on purpose.
 */

const SEGMENT_TONES = {
  brand: "bg-primary",
  danger: "bg-destructive",
  neutral: "bg-muted-foreground",
  success: "bg-success",
  warning: "bg-warning",
} as const;

export type SegmentTone = keyof typeof SEGMENT_TONES;

export type CardSegment = {
  /** Named in the accessibility label, so the track is not silent to a reader. */
  label: string;
  tone: SegmentTone;
  /** In the same unit as `total`. Rupees, beds, residents — never a percentage. */
  value: number;
};

/** Height of the split track, in points. Matches `<Meter>`'s default bar. */
const TRACK = 8;

/**
 * So a segment with a real but tiny value is still a visible mark rather than a
 * hairline the eye skips. A percentage of the track, because the track's own
 * width is not measured here.
 */
const MIN_SEGMENT = 3;

function SplitTrack({ segments, total }: { segments: readonly CardSegment[]; total: number }) {
  const claimed = segments.reduce((sum, segment) => sum + Math.max(0, segment.value), 0);

  /*
   * Guarded against both halves of the divide-by-zero: a `total` of zero has no
   * shares to compute, and a `claimed` that has overshot `total` — a hostel that
   * collected more than it billed, which happens the moment somebody pays two
   * months up front — would otherwise push the last segment off the end of the
   * track. Scaling by the larger of the two keeps the row inside its own width
   * in that case, and the remainder simply disappears, which is the truth.
   */
  const scale = Math.max(total, claimed);

  return (
    <View className="w-full flex-row gap-1 overflow-hidden rounded-full" style={{ height: TRACK }}>
      {scale <= 0
        ? null
        : segments.map((segment) => {
            const share = (Math.max(0, segment.value) / scale) * 100;

            if (share <= 0) {
              return null;
            }

            return (
              <View
                className={`rounded-full ${SEGMENT_TONES[segment.tone]}`}
                key={segment.label}
                style={{ width: `${Math.max(MIN_SEGMENT, share)}%` }}
              />
            );
          })}

      {/*
        The remainder, and it is `flex-1` rather than a computed width. The
        segments above are already sized in percent of the same parent, so the
        gaps between them are width this view cannot know about — letting it take
        whatever is left is the only way the row ends flush at every screen size.
      */}
      <View className="h-full flex-1 rounded-full bg-muted" />
    </View>
  );
}

export function DataCard({
  action,
  footer,
  meta,
  onPress,
  segments,
  stats,
  title,
  total,
}: {
  /** Right of the title — a badge, an icon button, a pill. */
  action?: ReactNode;
  footer?: { left?: string; pill?: string; right?: string };
  /** The line under the title: what this is, in a few words. */
  meta?: string;
  onPress?: () => void;
  segments?: readonly CardSegment[];
  /** Two or three. A fourth column takes the values below a legible size. */
  stats: readonly { label: string; value: string }[];
  title: string;
  /** The denominator for `segments`. Zero draws the empty track — see above. */
  total?: number;
}) {
  const { colors } = useAppTheme();

  const body = (
    <View className="gap-4 rounded-2xl border border-border bg-card p-4">
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1">
          <Text className="text-base font-semibold text-foreground" numberOfLines={1}>
            {title}
          </Text>
          {meta ? (
            <Text numberOfLines={1} variant="caption">
              {meta}
            </Text>
          ) : null}
        </View>

        {action}

        {onPress && !action ? (
          <Glyph color={colors.mutedForeground} name="chevron-forward" size={18} />
        ) : null}
      </View>

      <View className="flex-row gap-3">
        {stats.map((stat) => (
          <View className="flex-1" key={stat.label}>
            <Text
              className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
              numberOfLines={1}
            >
              {stat.label}
            </Text>
            <Text
              className="text-base font-semibold tracking-tight text-foreground"
              numberOfLines={1}
            >
              {stat.value}
            </Text>
          </View>
        ))}
      </View>

      {segments && segments.length > 0 ? (
        <SplitTrack segments={segments} total={total ?? 0} />
      ) : null}

      {footer ? (
        <View className="flex-row items-center justify-between gap-2">
          <Text className="shrink text-[11px] text-muted-foreground" numberOfLines={1}>
            {footer.left ?? ""}
          </Text>

          {footer.pill ? (
            <View className="rounded-full bg-brand-soft px-2.5 py-1">
              <Text className="text-[11px] font-bold text-primary" numberOfLines={1}>
                {footer.pill}
              </Text>
            </View>
          ) : null}

          <Text className="shrink text-right text-[11px] text-muted-foreground" numberOfLines={1}>
            {footer.right ?? ""}
          </Text>
        </View>
      ) : null}
    </View>
  );

  if (!onPress) {
    return body;
  }

  return (
    <Pressable
      accessibilityLabel={[
        title,
        meta,
        ...stats.map((stat) => `${stat.label}: ${stat.value}`),
        ...(segments ?? []).map((segment) => segment.label),
      ]
        .filter(Boolean)
        .join(", ")}
      accessibilityRole="button"
      className="active:opacity-70"
      onPress={() => {
        onPress();
      }}
    >
      {body}
    </Pressable>
  );
}
