import { Children, isValidElement, type ReactNode } from "react";
import { View } from "react-native";

import { Glyph, type GlyphName } from "@/components/ui/glyph";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Skeleton } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";

/**
 * The superadmin screens' one look (owner, 2026-11-17: "dont make it boxy",
 * "app current screen was wrst ui"). Content sits on the page: a small section
 * label, rows split by hairlines, figures as plain numbers. Colour marks only
 * what needs a look. A card is kept for the one object you act on — a payment
 * screenshot — never for a list.
 */

const TINTS = {
  brand: { bg: "bg-brand-soft", glyph: "primary", text: "text-primary" },
  danger: { bg: "bg-destructive-soft", glyph: "destructive", text: "text-destructive" },
  neutral: { bg: "bg-muted", glyph: "mutedForeground", text: "text-muted-foreground" },
  success: { bg: "bg-success-soft", glyph: "success", text: "text-success" },
  warning: { bg: "bg-warning-soft", glyph: "warning", text: "text-warning" },
} as const;

export type Tint = keyof typeof TINTS;

/** A soft round tint with the glyph in the tone's own colour. */
export function TintIcon({ icon, size = 36, tone = "brand" }: { icon: GlyphName; size?: number; tone?: Tint }) {
  const { colors } = useAppTheme();

  return (
    <View className={`items-center justify-center rounded-full ${TINTS[tone].bg}`} style={{ height: size, width: size }}>
      <Glyph color={colors[TINTS[tone].glyph]} name={icon} size={Math.round(size * 0.5)} />
    </View>
  );
}

/** A labelled block on the page. `count` rides beside the label, `action` on the right. */
export function Section({ action, children, count, title }: { action?: ReactNode; children: ReactNode; count?: number; title: string }) {
  return (
    <View>
      <View className="flex-row items-center justify-between pb-1">
        <Text className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {count ? `${title} · ${count}` : title}
        </Text>
        {action}
      </View>
      {children}
    </View>
  );
}

/** Rows split by hairlines, inset past the icon column. No box. Falsy children are skipped. */
export function Rows({ children, inset = true }: { children: ReactNode; inset?: boolean }) {
  return (
    <View>
      {Children.toArray(children).map((child, index) => (
        <View key={isValidElement(child) && child.key != null ? child.key : index}>
          {index > 0 ? <RowDivider inset={inset} /> : null}
          {child}
        </View>
      ))}
    </View>
  );
}

export type Figure = { label: string; loading?: boolean; tone?: Tint; value: number | string | null | undefined };

/** Figures across the page — number over label, a hairline between. */
export function Figures({ items }: { items: readonly Figure[] }) {
  return (
    <View className="flex-row py-1">
      {items.map((item, index) => (
        <View className={`flex-1 gap-0.5 ${index > 0 ? "border-l border-border/60 pl-4" : ""}`} key={item.label}>
          {item.loading ? (
            <Skeleton className="h-7 w-14" />
          ) : (
            <Text className={`font-amount text-xl font-bold tabular-nums ${item.tone ? TINTS[item.tone].text : "text-foreground"}`} numberOfLines={1}>
              {item.value ?? "—"}
            </Text>
          )}
          <Text numberOfLines={1} variant="caption">
            {item.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** Nothing to show: one quiet line with a tick, not an empty card. */
export function Quiet({ children, icon = "checkmark-circle", tone = "success" }: { children: string; icon?: GlyphName; tone?: Tint }) {
  return (
    <View className="flex-row items-center gap-3 py-3">
      <TintIcon icon={icon} size={32} tone={tone} />
      <Text className="flex-1" variant="muted">
        {children}
      </Text>
    </View>
  );
}

/** A row in a tinted circle. With `count`, the count is the point: a coloured number before the chevron. */
export function TintRow({
  count,
  icon,
  onPress,
  right,
  subtitle,
  title,
  tone = "brand",
  value,
}: {
  count?: number;
  icon: GlyphName;
  onPress?: () => void;
  right?: ReactNode;
  subtitle?: string;
  title: string;
  tone?: Tint;
  value?: string;
}) {
  const { colors } = useAppTheme();

  return (
    <ListRow
      left={<TintIcon icon={icon} tone={tone} />}
      onPress={onPress}
      right={
        right ??
        (count !== undefined ? (
          <View className="flex-row items-center gap-1">
            <Text className={`font-amount text-base font-bold tabular-nums ${TINTS[tone].text}`}>{count}</Text>
            {onPress ? <Glyph color={colors.mutedForeground} name="chevron-forward" size={18} /> : null}
          </View>
        ) : undefined)
      }
      subtitle={subtitle}
      title={title}
      value={value}
    />
  );
}
