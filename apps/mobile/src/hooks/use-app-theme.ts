import { colorScheme, useColorScheme } from "nativewind";
import { useEffect } from "react";
import { Appearance, useColorScheme as useDeviceColorScheme } from "react-native";
// NativeWind's own copy of the scheme — internal, so re-check this path on a NativeWind upgrade.
import { systemColorScheme } from "react-native-css-interop/dist/runtime/native/appearance-observables";

import { type ColorScheme, palette } from "@/constants/theme";
import { useAppSelector } from "@/hooks/redux";
import type { ThemePreference } from "@/store/slices/uiSlice";

function resolveScheme(preference: ThemePreference, device: string | null | undefined): ColorScheme {
  if (preference !== "system") return preference;
  return device === "dark" ? "dark" : "light";
}

/**
 * Puts the saved preference into NativeWind before the first screen renders.
 *
 * NativeWind starts on the phone's scheme, and `colorScheme.set` only reaches it
 * through the native appearance event, a beat later. So an app set to Light on
 * a phone in dark mode drew its first screens dark — a black gap between the
 * splash and Home — then rendered everything again in light. Called from
 * `PersistGate`'s `onBeforeLift`, the one point where the preference is known
 * and nothing has rendered yet.
 */
export function primeColorScheme(preference: ThemePreference) {
  const resolved = resolveScheme(preference, Appearance.getColorScheme());
  colorScheme.set(resolved);
  systemColorScheme.set(resolved);
}

/**
 * Resolves the active scheme from the user's preference, falling back to the OS.
 *
 * Also pushes that choice into NativeWind, which is what makes the `dark:`
 * variants and the `.dark` CSS block agree with everything reading `colors`
 * here. Without the push, a user who picks "Dark" while the phone is in light
 * mode gets dark tokens in JS and light ones in className — half a theme.
 *
 * The push is always a concrete "light" or "dark", never "system". NativeWind's
 * class strategy expresses dark as a class on the document, and "system" clears
 * that class instead of following the OS, so passing it through would leave an
 * OS-dark browser rendering light CSS under a dark JS palette. Resolving the
 * preference here keeps both sides reading the same value.
 */
export function useAppTheme() {
  const preference = useAppSelector((state) => state.ui.themePreference);
  const deviceScheme = useDeviceColorScheme();
  const { colorScheme: current, setColorScheme } = useColorScheme();

  const resolved = resolveScheme(preference, deviceScheme);

  useEffect(() => {
    if (current !== resolved) {
      setColorScheme(resolved);
    }
  }, [current, resolved, setColorScheme]);

  const scheme: ColorScheme = current === "dark" ? "dark" : "light";

  return {
    colors: palette[scheme],
    isDark: scheme === "dark",
    scheme,
  };
}
