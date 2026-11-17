import { colorScheme, useColorScheme } from "nativewind";
import { useEffect } from "react";
import { Appearance, useColorScheme as useDeviceColorScheme } from "react-native";
// NativeWind's own copy of the scheme — internal, so re-check this path on a NativeWind upgrade.
import { systemColorScheme } from "react-native-css-interop/dist/runtime/native/appearance-observables";

import { type ColorScheme, palette } from "@/constants/theme";
import { useAppSelector } from "@/hooks/redux";
import { setThemePreference, type ThemePreference } from "@/store/slices/uiSlice";

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
  /*
   * Straight from the preference, with no NativeWind subscription and no effect.
   * This hook runs in a few hundred components at once; it used to call
   * `setColorScheme` from an effect in every one of them, so a single theme
   * switch fired that call a few hundred times and every call re-notified
   * NativeWind — about two seconds of work, behind a frozen snapshot. The one
   * sync now lives in `useThemeSync`, and `applyThemePreference` flips NativeWind
   * in the same batch as the preference so the two never disagree.
   */
  const scheme = resolveScheme(preference, deviceScheme);

  return {
    colors: palette[scheme],
    isDark: scheme === "dark",
    scheme,
  };
}

/**
 * Keeps NativeWind's scheme equal to the resolved one. Mount it **once**, at the
 * root. It only matters for changes nobody called `applyThemePreference` for —
 * the phone's own dark-mode switch while the preference is "system".
 */
export function useThemeSync() {
  const preference = useAppSelector((state) => state.ui.themePreference);
  const deviceScheme = useDeviceColorScheme();
  const { colorScheme: current, setColorScheme } = useColorScheme();
  const resolved = resolveScheme(preference, deviceScheme);

  useEffect(() => {
    if (current !== resolved) {
      setColorScheme(resolved);
    }
  }, [current, resolved, setColorScheme]);
}

/** Change the theme: NativeWind first, then the preference, in one batch. */
export function applyThemePreference(
  preference: ThemePreference,
  dispatch: (action: ReturnType<typeof setThemePreference>) => unknown,
) {
  primeColorScheme(preference);
  dispatch(setThemePreference(preference));
}
