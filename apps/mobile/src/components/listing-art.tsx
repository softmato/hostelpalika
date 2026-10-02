import Svg, { Circle, Path, Rect } from "react-native-svg";
import { useAppTheme } from "@/hooks/use-app-theme";

export function ListingArt() {
  const { colors } = useAppTheme();
  return (
    <Svg width={88} height={88} viewBox="0 0 88 88" accessible={false}>
      <Circle cx="44" cy="44" r="42" fill={colors.primary} opacity={0.08} />
      <Rect
        x="22"
        y="17"
        width="43"
        height="58"
        rx="9"
        fill={colors.card}
        stroke={colors.primary}
        strokeWidth="2"
      />
      <Path
        d="M30 36L43 26L56 36M33 34V51H53V34M41 51V41H46V51M31 60H55M31 66H46"
        fill="none"
        stroke={colors.primary}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Circle cx="66" cy="24" r="12" fill={colors.primary} />
      <Path
        d="M61 24L65 28L72 20"
        fill="none"
        stroke={colors.primaryForeground}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
