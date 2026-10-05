import { GLYPHS, type GlyphName } from "@hostel/shared/constants/glyphs";

/** One of our own line icons (see `glyphs.ts`). Takes `currentColor`, so colour it with a text token. */
export function Glyph({
  className = "size-5",
  name,
  strokeWidth = 1.6,
}: {
  className?: string;
  name: GlyphName;
  strokeWidth?: number;
}) {
  return (
    <svg aria-hidden="true" className={className} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={strokeWidth} viewBox="0 0 24 24">
      {GLYPHS[name].map((d) => <path d={d} key={d} />)}
    </svg>
  );
}
