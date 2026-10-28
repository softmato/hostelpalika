import { useMemo } from "react";
import Svg, { Rect } from "react-native-svg";
import { toQR } from "toqr";

import { useAppTheme } from "@/hooks/use-app-theme";

/** A QR code drawn as SVG squares on the page colour, with the four-module quiet zone scanners need. */
export function Qr({ text, size }: { size: number; text: string }) {
  const { colors } = useAppTheme();
  const modules = useMemo(() => toQR(text), [text]);
  const width = Math.sqrt(modules.length);
  const cell = size / (width + 8);

  return (
    <Svg height={size} width={size}>
      <Rect fill={colors.background} height={size} width={size} />
      {Array.from(modules, (on, index) =>
        on ? (
          <Rect
            fill={colors.foreground}
            height={cell}
            key={index}
            width={cell}
            x={(4 + (index % width)) * cell}
            y={(4 + Math.floor(index / width)) * cell}
          />
        ) : null,
      )}
    </Svg>
  );
}
