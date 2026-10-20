import type { ReactNode } from "react";
import { ActivityIndicator, View } from "react-native";

import { Glyph, type GlyphName } from "@/components/ui/glyph";
import { PressableScale } from "@/components/ui/pressable-scale";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";

/**
 * One line in a list: a label, an optional second line, something on the right.
 *
 * Rows are the app's densest surface, so the tap target is set by `min-h-14`
 * rather than by whatever the text happens to measure — a one-line row and a
 * two-line row must not have different-sized hit areas, and 56dp clears the
 * 48dp Android minimum with room for the divider.
 */
export function ListRow({
  busy = false,
  className = "",
  icon,
  iconBgColor,
  iconColor,
  left,
  onPress,
  onPressIn,
  right,
  subtitle,
  title,
  value,
}: {
  busy?: boolean;
  className?: string;
  icon?: GlyphName;
  /** Background color for iOS-style colorful square icon tile (e.g. "#FF9500") */
  iconBgColor?: string;
  /** Foreground icon color override (defaults to white if iconBgColor is present) */
  iconColor?: string;
  left?: ReactNode;
  onPress?: () => void;
  onPressIn?: () => void;
  right?: ReactNode;
  subtitle?: string;
  title: string;
  value?: string;
}) {
  const { colors } = useAppTheme();

  const body = (
    <View className={`min-h-14 flex-row items-center gap-3 py-3 ${className}`}>
      {left ??
        (icon ? (
          <View
            className={`h-8 w-8 items-center justify-center ${
              iconBgColor ? "rounded-[9px] shadow-sm" : "rounded-full bg-muted"
            }`}
            style={iconBgColor ? { backgroundColor: iconBgColor } : undefined}
          >
            <Glyph
              color={iconColor ?? (iconBgColor ? "#FFFFFF" : colors.mutedForeground)}
              name={icon}
              size={18}
            />
          </View>
        ) : null)}

      <View className="flex-1">
        <Text numberOfLines={1} variant="label">
          {title}
        </Text>
        {subtitle ? (
          <Text numberOfLines={2} variant="caption">
            {subtitle}
          </Text>
        ) : null}
      </View>

      {busy ? (
        <ActivityIndicator color={colors.mutedForeground} size="small" />
      ) : (
        (right ?? (
          <View className="flex-row items-center gap-1">
            {value ? <Text variant="muted">{value}</Text> : null}
            {onPress ? (
              <Glyph color={colors.mutedForeground} name="chevron-forward" size={18} />
            ) : null}
          </View>
        ))
      )}
    </View>
  );

  if (!onPress) {
    return body;
  }

  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityState={{ busy, disabled: busy }}
     
      disabled={busy}
      onPress={() => {        onPress();
      }}
      onPressIn={onPressIn}
    >
      {body}
    </PressableScale>
  );
}

/** A hairline between rows. Inset past the icon column so it reads as a group. */
export function RowDivider({ inset = false }: { inset?: boolean }) {
  return <View className={`h-px bg-border/60 ${inset ? "ml-[52px]" : ""}`} />;
}

const CARD_ROW_TONES = {
  brand: "bg-brand-soft",
  danger: "bg-destructive/10",
  neutral: "bg-muted",
  success: "bg-success-soft",
  warning: "bg-warning-soft",
} as const;

const CARD_ROW_GLYPH: Record<
  keyof typeof CARD_ROW_TONES,
  "destructive" | "mutedForeground" | "primary" | "success" | "warning"
> = {
  brand: "primary",
  danger: "destructive",
  neutral: "mutedForeground",
  success: "success",
  warning: "warning",
};

/**
 * A row that is its own card, for a list of unrelated destinations.
 *
 * ## When this and not `<ListRow>`
 *
 * `<ListRow>` lives *inside* a `<Card>`, separated from its neighbours by a
 * hairline, and the card around it is a claim: **these rows belong together**.
 * That is right for a queue, for the fields of one object, for a settings group.
 *
 * It is wrong for a menu. Eight destinations that share nothing but a screen —
 * Finance, Rooms, Food, Reports — inside one bordered box read as one list you
 * are meant to work down in order, and the hairlines make every row look like a
 * row of a table. Separate cards say what is actually true: each of these is a
 * door, they are siblings, and you want exactly one of them.
 *
 * The gap between them is the caller's, not this component's — a list wraps
 * these in `gap-3`, and a lone card can sit anywhere without shedding a margin
 * it did not ask for.
 *
 * ## The icon is a tinted square, not a grey circle
 *
 * `<ListRow>`'s leading circle is deliberately quiet because it repeats down a
 * dense list. Here there are six or eight of them with air in between, they are
 * the fastest way to tell one door from another before reading, and a tone can
 * carry meaning the title has no room for. Squares because the tile shape is
 * what the rest of this app uses for "a thing you can open" — see `<InfoTile>`.
 */
export function CardRow({
  icon,
  left,
  onPress,
  onPressIn,
  right,
  subtitle,
  title,
  tone = "brand",
  value,
}: {
  icon?: GlyphName;
  /**
   * Replaces the tinted icon square — an `<Avatar>`, a thumbnail.
   *
   * Takes precedence over `icon` rather than rendering beside it, exactly as
   * `<ListRow>` does: a row with both a face and a symbol in front of the text
   * has two leading columns and no clear subject. A roster of forty people wants
   * the face, because an initial circle coloured from the name is what makes two
   * adjacent rows tell themselves apart before either is read.
   */
  left?: ReactNode;
  onPress?: () => void;
  /**
   * Touch-down, before the press resolves.
   *
   * One use only: starting the fetch the destination is about to make, so the
   * screen behind the row is already loading while the finger is still on it.
   * See `prefetchAdminRoute` in `lib/admin-queries.ts`.
   *
   * It must stay side-effect-free beyond that — this fires on a press that is
   * then dragged off and cancelled, so anything that *changes* something would
   * happen without the user having chosen it.
   */
  onPressIn?: () => void;
  /** Replaces the chevron/value slot — a switch, a badge, a count pill. */
  right?: ReactNode;
  subtitle?: string;
  title: string;
  tone?: keyof typeof CARD_ROW_TONES;
  /** Right-aligned secondary text, e.g. an amount or a date. */
  value?: string;
}) {
  const { colors } = useAppTheme();

  const body = (
    <View
      className="flex-row items-center gap-3 rounded-2xl border border-border bg-card px-3 py-3"
      /*
        A style, not `min-h-[60px]`. NativeWind builds its class list by scanning
        source, so an arbitrary value used in exactly one place is missing from
        the stylesheet until the bundler rebuilds — the rule silently does
        nothing and the row collapses to its text height. Measured dimensions in
        this app are written as styles for that reason.
      */
      style={{ minHeight: 60 }}
    >
      {left ??
        (icon ? (
          <View
            className={`h-10 w-10 items-center justify-center rounded-xl ${CARD_ROW_TONES[tone]}`}
          >
            <Glyph color={colors[CARD_ROW_GLYPH[tone]]} name={icon} size={19} />
          </View>
        ) : null)}

      <View className="flex-1">
        <Text
          className="font-semibold text-foreground"
          numberOfLines={1}
          style={{ fontSize: 15 }}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text numberOfLines={2} variant="caption">
            {subtitle}
          </Text>
        ) : null}
      </View>

      {right ?? (
        <View className="flex-row items-center gap-1">
          {value ? <Text variant="muted">{value}</Text> : null}
          {onPress ? (
            <Glyph color={colors.mutedForeground} name="chevron-forward" size={18} />
          ) : null}
        </View>
      )}
    </View>
  );

  if (!onPress) {
    return body;
  }

  return (
    <PressableScale
      accessibilityLabel={subtitle ? `${title}. ${subtitle}` : title}
      accessibilityRole="button"
     
      onPress={() => {        onPress();
      }}
      onPressIn={onPressIn}
    >
      {body}
    </PressableScale>
  );
}
