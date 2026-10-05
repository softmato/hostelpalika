import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { type ReactNode, useState } from "react";
import {
  ActivityIndicator,
  type LayoutChangeEvent,
  Pressable,
  View,
} from "react-native";

import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { cellWidth, columnsThatFit } from "@/lib/responsive";

/**
 * The pieces every screen arranges itself out of, sized to the phone in hand.
 *
 * Not web responsive design — there is no desktop layout here and nothing turns
 * into a sidebar. What these solve is the handset range: a 320dp phone is 28%
 * narrower than a 430dp one, and a tile row hardcoded to four columns truncates
 * its labels on the small end while leaving a hole on the large one. `<Grid>`
 * measures the space it was actually given and fits what fits.
 *
 * The arithmetic is in `lib/responsive.ts`, where it is tested; this file holds
 * only what has to touch React Native.
 */

/**
 * A row of equal cells that wraps, sized from the width it is measured at.
 *
 * ## Why measured rather than `flex: 1` on the children
 *
 * Flex alone cannot answer "how many". A four-item row of `flex-1` cells stays
 * four items at any width — it squeezes them until the labels ellipsize instead
 * of dropping to three. And percentage widths with a gap overflow by a fraction
 * of a pixel and wrap the last cell onto its own line, on one screen width and
 * no other.
 *
 * So the container measures itself once, `columnsThatFit` decides the count from
 * `minCellWidth`, and every cell gets an exact pixel width. Nothing renders
 * before the measurement, which costs one frame and is the difference between a
 * grid that settles and one that visibly reflows on every open.
 */
export function Grid({
  children,
  className = "",
  gap = 12,
  maxColumns = 4,
  minCellWidth = 96,
}: {
  children: ReactNode[];
  className?: string;
  gap?: number;
  /** The cap, for when the container is wide enough to spread things too thin. */
  maxColumns?: number;
  /** Below this a cell's content stops fitting. The number that decides the count. */
  minCellWidth?: number;
}) {
  const [width, setWidth] = useState(0);

  const onLayout = (event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout.width;

    // Guarded: `onLayout` fires on every rotation and keyboard resize, and an
    // unconditional `setState` here is a render loop on some Android devices.
    setWidth((current) => (Math.abs(current - next) > 0.5 ? next : current));
  };

  const items = children.filter(Boolean);
  const columns = columnsThatFit(width, minCellWidth, gap, maxColumns);
  const cell = cellWidth(width, columns, gap);

  return (
    <View
      className={`flex-row flex-wrap ${className}`}
      onLayout={onLayout}
      style={{ gap }}
    >
      {width === 0
        ? null
        : items.map((child, index) => (
            // Positional keys are correct here: a cell *is* its position in the
            // row, and the children are a fixed list from the call site.
            <View key={index} style={{ width: cell }}>
              {child}
            </View>
          ))}
    </View>
  );
}

const TILE_TONES = {
  brand: {
    badge: "bg-primary",
    icon: "text-primary",
    surface: "bg-brand-soft",
  },
  danger: {
    badge: "bg-destructive",
    icon: "text-destructive",
    surface: "bg-destructive-soft",
  },
  neutral: {
    badge: "bg-muted-foreground",
    icon: "text-muted-foreground",
    surface: "bg-muted",
  },
  success: {
    badge: "bg-success",
    icon: "text-success",
    surface: "bg-success-soft",
  },
  warning: {
    badge: "bg-warning",
    icon: "text-warning",
    surface: "bg-warning-soft",
  },
} as const;

export type TileTone = keyof typeof TILE_TONES;

const TONE_COLOR: Record<
  TileTone,
  "destructive" | "mutedForeground" | "primary" | "success" | "warning"
> = {
  brand: "primary",
  danger: "destructive",
  neutral: "mutedForeground",
  success: "success",
  warning: "warning",
};

/**
 * An icon over a label, in a bordered cell — the facilities/quick-action tile.
 *
 * Two lines of text at most: a **label** (what it is) and an optional
 * **caption** (the detail, e.g. "24/7" under "Hot water"). Both wrap rather than
 * truncate, because `<Grid>` has already guaranteed the cell is wide enough for
 * the text at this screen size, and a wrapped second line is readable where an
 * ellipsis is not.
 *
 * ## The corner count
 *
 * `badge` turns the tile from a door into a **queue**: how many things are
 * behind it, before it is opened. It sits in the corner rather than under the
 * label because the label already owns that line, and a number in a tile's
 * corner is the one place a phone user has been trained by every app on their
 * home screen to look for "how many".
 *
 * A zero badge goes grey whatever the tone. A grid of coloured pills reading `0`
 * is a screen shouting about nothing, and it teaches people to ignore the colour
 * on the day one of them is not zero — the same rule `AttentionRow` holds, kept
 * in step deliberately.
 */
export function InfoTile({
  badge,
  caption,
  icon,
  image,
  label,
  onPress,
  tone = "brand",
}: {
  /** A count in the corner. Omit entirely for a tile that is not a queue. */
  badge?: number;
  caption?: string;
  icon: keyof typeof Ionicons.glyphMap;
  /** A photo URI drawn in the glyph's square instead of the icon. */
  image?: string | null;
  label: string;
  onPress?: () => void;
  tone?: TileTone;
}) {
  const { colors } = useAppTheme();
  const palette = TILE_TONES[tone];
  const quiet = badge === 0;

  const body = (
    <View className="min-h-[92px] flex-1 items-center justify-center gap-2 rounded-2xl border border-border bg-card px-2 py-3">
      {/*
        The glyph is `QuickAction`'s, to the point: a 48-point tinted square with
        `rounded-2xl` corners and a 21-point icon in it, under an 11-point
        medium label. Those two rows sit one above the other on admin Home — the
        shortcuts straddling the card, the queues under "Waiting for you" — and
        at 40/19/12 against 48/21/11 they were near-identical without being the
        same, which reads as sloppiness rather than as a distinction.

        The tile keeps the parts the shortcut row does not have: the border and
        card fill that make it an enclosed cell, and the corner count.
      */}
      {image ? (
        <Image
          contentFit="cover"
          source={{ uri: image }}
          style={{ borderRadius: 16, height: 48, width: 48 }}
        />
      ) : (
        <View
          className={`h-12 w-12 items-center justify-center rounded-2xl ${palette.surface}`}
        >
          <Ionicons color={colors[TONE_COLOR[tone]]} name={icon} size={21} />
        </View>
      )}

      <View className="items-center gap-0.5">
        <Text
          className="text-center font-medium text-foreground"
          style={{ fontSize: 11 }}
        >
          {label}
        </Text>
        {caption ? (
          <Text className="text-center text-[11px] text-muted-foreground">
            {caption}
          </Text>
        ) : null}
      </View>

      {badge === undefined ? null : (
        <View
          className={`absolute right-1.5 top-1.5 h-5 items-center justify-center rounded-full px-1.5 ${
            quiet ? "bg-muted" : palette.badge
          }`}
          // A style rather than `min-w-[20px]` — see the note in `<CardRow>`.
          style={{ minWidth: 20 }}
        >
          <Text
            className={`text-[11px] font-bold ${quiet ? "text-muted-foreground" : "text-white"}`}
          >
            {badge}
          </Text>
        </View>
      )}
    </View>
  );

  if (!onPress) {
    return body;
  }

  return (
    <Pressable
      accessibilityLabel={[
        label,
        caption,
        badge === undefined ? null : `${badge} waiting`,
      ]
        .filter(Boolean)
        .join(", ")}
      accessibilityRole="button"
      className="flex-1 active:opacity-70"
      onPress={() => {
        onPress();
      }}
    >
      {body}
    </Pressable>
  );
}

/**
 * A number with a name — the metric box that runs across the top of a dashboard.
 *
 * Distinct from `<InfoTile>` on purpose: this one leads with a **value**, so the
 * value is the largest thing in it and is left-aligned for scanning down a
 * column of them. A tile that leads with an icon and a tile that leads with a
 * number should not be the same component with a flag.
 */
export function StatTile({
  icon,
  label,
  onPress,
  tone = "neutral",
  trend,
  value,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress?: () => void;
  tone?: TileTone;
  /** The line under the value: what it means, or where it is going. */
  trend?: string;
  value: string;
}) {
  const { colors } = useAppTheme();
  const palette = TILE_TONES[tone];

  const body = (
    <View className="flex-1 gap-1 rounded-2xl border border-border bg-card p-3">
      {/*
        The value shares the top row with the icon; the name gets a line of its
        own underneath.

        Three of these fit across a 360dp phone, which leaves each tile about
        77dp of content — not enough for a name and an icon side by side. A
        two-word label wrapped to two lines and pushed the icon out through the
        card's right edge, and the wrap is what made the row so tall. A number
        is short and an icon is a fixed 24dp, so they share happily, and the
        name gets the full width. The value stays the largest thing here.
      */}
      <View className="flex-row items-center justify-between gap-2">
        <Text
          className="shrink text-lg font-semibold tracking-tight text-foreground"
          numberOfLines={1}
        >
          {value}
        </Text>
        <View
          className={`h-6 w-6 shrink-0 items-center justify-center rounded-lg ${palette.surface}`}
        >
          <Ionicons color={colors[TONE_COLOR[tone]]} name={icon} size={13} />
        </View>
      </View>

      <Text
        className="text-[11px] font-medium text-muted-foreground"
        numberOfLines={1}
      >
        {label}
      </Text>

      {trend ? (
        <Text numberOfLines={1} variant="caption">
          {trend}
        </Text>
      ) : null}
    </View>
  );

  if (!onPress) {
    return body;
  }

  return (
    <Pressable
      accessibilityLabel={`${label}: ${value}`}
      accessibilityRole="button"
      className="flex-1 active:opacity-70"
      onPress={onPress}
    >
      {body}
    </Pressable>
  );
}

/**
 * A small bordered pill: a fact, or a tap target for one.
 *
 * The mockup's phone/email/link row. On a phone these are worth more than they
 * are on the web — a phone number in a chip is one tap to a call, where the web
 * version is a number to memorise — so `onPress` is the common case rather than
 * the exception.
 */
export function Chip({
  busy = false,
  icon,
  label,
  onPress,
  tone = "neutral",
}: {
  /**
   * This chip's own action is at the server.
   *
   * A chip is a small control, but a pressable one can still be the thing that
   * assigns a plumber to a job — `manage/maintenance`'s provider list is a row
   * of them — and a control that hits the network has to say so. The icon slot
   * becomes the spinner, which keeps the chip the same width it was, and the
   * press is refused while it spins.
   */
  busy?: boolean;
  icon?: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress?: () => void;
  tone?: "brand" | "neutral";
}) {
  const { colors } = useAppTheme();
  const brand = tone === "brand";

  const body = (
    <View
      className={`max-w-full flex-row items-center gap-1.5 rounded-lg border px-2.5 py-1.5 ${
        brand ? "border-primary/30 bg-brand-soft" : "border-border bg-card"
      }`}
    >
      {busy ? (
        <ActivityIndicator
          color={brand ? colors.primary : colors.mutedForeground}
          // Sized down to the icon it stands in for: an untamed `small`
          // indicator is 20dp and would make the chip grow as it starts.
          size="small"
          style={{ height: 13, transform: [{ scale: 0.62 }], width: 13 }}
        />
      ) : icon ? (
        <Ionicons
          color={brand ? colors.primary : colors.mutedForeground}
          name={icon}
          size={13}
        />
      ) : null}
      <Text
        className={`shrink text-xs font-semibold ${brand ? "text-primary" : "text-foreground"}`}
        numberOfLines={1}
      >
        {label}
      </Text>
    </View>
  );

  if (!onPress) {
    return body;
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ busy, disabled: busy }}
      className="shrink active:opacity-70"
      disabled={busy}
      hitSlop={4}
      onPress={onPress}
      style={busy ? { opacity: 0.7 } : undefined}
    >
      {body}
    </Pressable>
  );
}

/**
 * A label on the left, a value on the right — the "Hostel information" table.
 *
 * The value is allowed to wrap onto its own line rather than being squeezed:
 * two columns on a 320dp screen leave about 150dp for the value, and a warden's
 * full name does not fit in it. `<ListRow>` is the pressable, icon-led sibling;
 * this one is for dense read-only facts.
 */
export function FactRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <View className="flex-row items-start justify-between gap-4 py-2.5">
      <Text className="shrink-0 text-sm text-muted-foreground">{label}</Text>
      <View className="flex-1 items-end">
        {typeof value === "string" ? (
          <Text className="text-right text-sm font-medium text-foreground">
            {value}
          </Text>
        ) : (
          value
        )}
      </View>
    </View>
  );
}
