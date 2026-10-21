import { memo } from "react";
import type { ColorValue, StyleProp, ViewStyle } from "react-native";
import Svg, { Path } from "react-native-svg";

import { GLYPHS, type GlyphName, type GlyphVariant, resolveGlyph, SOLID_GLYPHS } from "@hostel/constants/glyphs";

export type { GlyphName, GlyphVariant };

/**
 * One of our own icons (see `glyphs.ts`). Colour is a theme token, passed in.
 *
 * `solid` is for the selected or active state only — the focused tab, a ticked
 * box, a starred rating. An icon with no solid drawing falls back to its line at
 * a heavier stroke, so the state still reads.
 *
 * Memoised: every prop is a primitive at nearly every call site, and an icon is a
 * native SVG tree, so a parent re-rendering for a keystroke or a focus change
 * should not rebuild the hundreds of them a list screen holds.
 */
export const Glyph = memo(function Glyph({
  accessibilityLabel,
  color,
  name,
  size = 20,
  strokeWidth = 1.6,
  style,
  variant = "line",
}: {
  accessibilityLabel?: string;
  color: ColorValue;
  name: GlyphName;
  size?: number;
  strokeWidth?: number;
  style?: StyleProp<ViewStyle>;
  variant?: GlyphVariant;
}) {
  const a11y = accessibilityLabel
    ? { accessibilityLabel, accessibilityRole: "image" as const, accessible: true }
    : { accessible: false };
  // Names can come from data (store items, site config), so resolve, never index.
  const glyph = resolveGlyph(name);
  const solid = variant === "solid" ? SOLID_GLYPHS[glyph] : undefined;

  if (solid) {
    return (
      <Svg fill={color} height={size} style={style} viewBox="0 0 24 24" width={size} {...a11y}>
        {solid.map((d) => <Path d={d} fillRule="evenodd" key={d} />)}
      </Svg>
    );
  }

  return (
    <Svg
      fill="none"
      height={size}
      stroke={color}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={variant === "solid" ? strokeWidth + 0.6 : strokeWidth}
      style={style}
      viewBox="0 0 24 24"
      width={size}
      {...a11y}
    >
      {GLYPHS[glyph].map((d) => <Path d={d} key={d} />)}
    </Svg>
  );
});
