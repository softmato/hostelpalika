import type { SVGProps } from "react";

import { GLYPHS, type GlyphName, type GlyphVariant, resolveGlyph, SOLID_GLYPHS } from "@hostel/shared/constants/glyphs";

export type { GlyphName, GlyphVariant };

export type GlyphProps = Omit<SVGProps<SVGSVGElement>, "name"> & {
  name: GlyphName;
  size?: number | string;
  /** `solid` is the selected or active state only. With no solid drawing, the line is drawn heavier. */
  variant?: GlyphVariant;
};

/**
 * One of our own icons (see `glyphs.ts`). Takes `currentColor`, so colour it
 * with a text token. `fill-*` classes still work: CSS beats the attribute.
 */
export function Glyph({ className = "size-5", name, size = 24, strokeWidth = 1.6, variant = "line", ...rest }: GlyphProps) {
  const labelled = rest["aria-label"] !== undefined || rest["aria-labelledby"] !== undefined;
  const glyph = resolveGlyph(name);
  const solid = variant === "solid" ? SOLID_GLYPHS[glyph] : undefined;
  const common = {
    "aria-hidden": labelled ? undefined : true,
    className,
    height: size,
    role: labelled ? "img" : undefined,
    viewBox: "0 0 24 24",
    width: size,
    xmlns: "http://www.w3.org/2000/svg",
    ...rest,
  };

  if (solid) {
    return (
      <svg fill="currentColor" {...common}>
        {solid.map((d) => <path d={d} fillRule="evenodd" key={d} />)}
      </svg>
    );
  }

  return (
    <svg
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={variant === "solid" ? Number(strokeWidth) + 0.6 : strokeWidth}
      {...common}
    >
      {GLYPHS[glyph].map((d) => <path d={d} key={d} />)}
    </svg>
  );
}
