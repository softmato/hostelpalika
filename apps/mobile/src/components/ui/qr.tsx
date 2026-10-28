import { useMemo } from "react";
import Svg, { Path, Rect } from "react-native-svg";
import { toQR } from "toqr";

import { useAppTheme } from "@/hooks/use-app-theme";

/** A QR code drawn as SVG squares on the page colour, with the four-module quiet zone scanners need. */
export function Qr({ text, size }: { size: number; text: string }) {
  const { colors } = useAppTheme();

  /*
   * One path, not one <Rect> per module: a link QR is ~400 dark squares, and
   * that many native SVG views held the screen blank for seconds on mount.
   */
  const { d, width } = useMemo(() => {
    const modules = toQR(text);
    const side = Math.sqrt(modules.length);
    let path = "";

    modules.forEach((on, index) => {
      if (on) path += `M${4 + (index % side)} ${4 + Math.floor(index / side)}h1v1h-1z`;
    });

    return { d: path, width: side + 8 };
  }, [text]);

  return (
    <Svg height={size} viewBox={`0 0 ${width} ${width}`} width={size}>
      <Rect fill={colors.background} height={width} width={width} />
      <Path d={d} fill={colors.foreground} />
    </Svg>
  );
}
