import Svg, { Path } from "react-native-svg";

import { GLYPHS, type GlyphName } from "@hostel/constants/glyphs";

/** One of our own line icons (see `glyphs.ts`). Colour is a theme token, passed in. */
export function Glyph({
  color,
  name,
  size = 20,
  strokeWidth = 1.6,
}: {
  color: string;
  name: GlyphName;
  size?: number;
  strokeWidth?: number;
}) {
  return (
    <Svg fill="none" height={size} stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeWidth={strokeWidth} viewBox="0 0 24 24" width={size}>
      {GLYPHS[name].map((d) => <Path d={d} key={d} />)}
    </Svg>
  );
}
