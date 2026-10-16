import type { ReactNode } from "react";
import { Pressable, TextInput, View } from "react-native";

import { Glyph } from "@/components/ui/glyph";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useSystemInsets } from "@/hooks/use-system-insets";

/**
 * A screen title with the search field built into the bar.
 *
 * ## Why the Residents tab gets its own bar
 *
 * A directory is something you look *into*, and the control that does the
 * looking should not be the third thing on the page under two rows of figures —
 * it should be the chrome. Putting the field in the bar also pins it: the list
 * scrolls under it, so on a forty-row roster the search is still there when you
 * have scrolled past the person you were looking for and want to try a name.
 *
 * This is the same shape `discovery-header.tsx` uses for the public home, for
 * the same reason, and deliberately not the same component: that one carries a
 * two-tone wordmark, an ID-card action, a map button and a filter button that
 * pushes a route, none of which mean anything here. Sharing them would give
 * this bar four props it always passes `undefined` to.
 *
 * ## It is page-coloured, not painted
 *
 * The admin group's other bars are painted; this one is not, and that is the
 * point — five tabs whose top two hundred points are identical is a failure to
 * say where you are. A field wants a page background behind it anyway: a text
 * input on a saturated ground reads as disabled.
 */

/**
 * The field's height, in points.
 *
 * Measured as a style rather than written `h-[46px]`: NativeWind compiles its
 * class list from a build-time scan, so an arbitrary value used nowhere else is
 * absent from the stylesheet until the bundler rebuilds — the class resolves to
 * nothing and the field silently renders at its content height.
 */
const FIELD_HEIGHT = 46;

/** The glyphs inside the field. One number, because they are one row. */
const FIELD_GLYPH = 16;

export function AdminSearchBar({
  actions,
  onQueryChange,
  placeholder,
  query,
  subtitle,
  title,
}: {
  /** The right-hand slot on the title row — the bell. */
  actions?: ReactNode;
  onQueryChange: (value: string) => void;
  placeholder: string;
  query: string;
  subtitle?: string;
  title: string;
}) {
  const insets = useSystemInsets();
  const { colors } = useAppTheme();

  return (
    /*
     * An explicit colour, not a `bg-*` class. This strip is the one surface with
     * nothing behind it but the window, so a class that fails to resolve — a
     * stale NativeWind cache, a CSS rebuild that has not happened — renders as a
     * black bar under the clock while the rest of the app is white.
     */
    <View style={{ backgroundColor: colors.background, paddingTop: insets.top }}>
      <View className="gap-3 px-5 pb-3 pt-2">
        <View className="flex-row items-center gap-3">
          <View className="flex-1">
            <Text numberOfLines={1} variant="title">
              {title}
            </Text>
            {subtitle ? (
              <Text numberOfLines={1} variant="caption">
                {subtitle}
              </Text>
            ) : null}
          </View>

          {actions}
        </View>

        {/*
          A bare `TextInput`, not the design system's `Input`: that carries a
          label, its own border and its own height, all of which fight a field
          that is meant to read as part of the bar.
        */}
        <View
          className="flex-row items-center gap-2 rounded-2xl border border-border bg-card"
          style={{ height: FIELD_HEIGHT, paddingLeft: 12, paddingRight: 10 }}
        >
          <Glyph color={colors.mutedForeground} name="search" size={FIELD_GLYPH} />

          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            className="h-full flex-1 text-base text-foreground"
            onChangeText={onQueryChange}
            placeholder={placeholder}
            placeholderTextColor={colors.mutedForeground}
            returnKeyType="search"
            value={query}
          />

          {query ? (
            <Pressable
              accessibilityLabel="Clear search"
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => onQueryChange("")}
            >
              <Glyph
                color={colors.mutedForeground}
                name="close-circle"
                size={FIELD_GLYPH}
              />
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
}
