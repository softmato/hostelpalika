/**
 * The same tokens as `src/global.css`, as JS values.
 *
 * NativeWind resolves `var(--x)` for anything styled with `className`, but a
 * handful of consumers cannot use className at all — the status bar, native
 * navigator options, the splash background, `expo-notifications` channel
 * colours, gradient stop arrays. Those read from here.
 *
 * Keep the two files in step. If a colour exists in only one of them, it is a
 * bug waiting for dark mode.
 */

export const palette = {
  light: {
    background: "#f7f7f6",
    foreground: "#1c1917",
    card: "#ffffff",
    cardForeground: "#1c1917",
    primary: "#0a8a4b",
    primaryForeground: "#ffffff",
    secondary: "#f4f4f5",
    muted: "#efefee",
    mutedForeground: "#78716c",
    destructive: "#dc2626",
    border: "#e7e5e4",
    surface: "#fffaf4",
    warning: "#d97706",
    success: "#16a34a",
    info: "#2563eb",
    infoSoft: "#e8effd",
    brand: "#0a8a4b",
    brandSoft: "#e6f4ec",
  },
  dark: {
    background: "#0c0a09",
    foreground: "#fafaf9",
    card: "#1c1917",
    cardForeground: "#fafaf9",
    primary: "#12a95d",
    primaryForeground: "#04140c",
    secondary: "#27272a",
    muted: "#292524",
    mutedForeground: "#a8a29e",
    destructive: "#ef4444",
    border: "#292524",
    surface: "#1c1917",
    warning: "#f59e0b",
    success: "#22c55e",
    info: "#60a5fa",
    infoSoft: "#0e1c33",
    brand: "#12a95d",
    brandSoft: "#07301f",
  },
} as const;

export type ColorScheme = keyof typeof palette;
export type ThemeColors = (typeof palette)[ColorScheme];

/**
 * Portal chrome, one per audience. The accent picks out *which product* you are
 * in at a glance — a cook and a resident should never wonder whose screen this
 * is. Mirrors `--role-*` in global.css and docs/DESIGN.md.
 */
export const roleAccent = {
  /*
   * Green, not the cyan it shipped with.
   *
   * The rule below still holds for every other portal — an accent says which
   * product you are in — but the hostel admin is not "another product" to the
   * person holding the phone: it is the same green app they browse hostels in,
   * signed in with more powers. A cyan chrome under a green brand read as a
   * second app, and the owner asked for the public palette here. What tells the
   * portals apart is now the *shape* of each screen, which is where that job
   * belonged all along — see `portal-shared.tsx`.
   */
  ADMIN: { light: "#0a8a4b", dark: "#12a95d", soft: "role-admin-soft", token: "role-admin" },
  COOK: { light: "#ea580c", dark: "#fb923c", soft: "role-cook-soft", token: "role-cook" },
  GUARDIAN: {
    light: "#d97706",
    dark: "#f59e0b",
    soft: "role-guardian-soft",
    token: "role-guardian",
  },
  PLATFORM: {
    light: "#0d9488",
    dark: "#2dd4bf",
    soft: "role-platform-soft",
    token: "role-platform",
  },
  PROVIDER: {
    light: "#7c3aed",
    dark: "#a78bfa",
    soft: "role-provider-soft",
    token: "role-provider",
  },
  PUBLIC: { light: "#0a8a4b", dark: "#12a95d", soft: "brand-soft", token: "brand" },
  RESIDENT: {
    light: "#16a34a",
    dark: "#22c55e",
    soft: "role-resident-soft",
    token: "role-resident",
  },
} as const;

export type RoleAccentKey = keyof typeof roleAccent;

/**
 * The hostel admin Home hero, as gradient stops.
 *
 * JS-only by construction — `LinearGradient` takes an array of colour *values*,
 * not a class — so this is the one token with no `global.css` twin, and both
 * schemes therefore have to live here or dark mode gets a light-mode header.
 *
 * ## It is the brand green now, top to bottom
 *
 * It used to run cyan → teal, and the long note that lived here was entirely
 * about managing the hue shift that travel caused: over a hostel's photograph
 * the building came out blue at the top and green at the bottom. Both stops are
 * now the same hue at two depths, so there is no hue to shift and the ramp only
 * carries light — which is what a gradient on a card should be doing anyway.
 *
 * The pair is deliberately shallow. `#0a8a4b` is the brand, `#046b48` is the
 * same green with the lights down; far enough apart for the hero to read as an
 * object with a top and a bottom, near enough that the journey is never the
 * loudest thing on the screen.
 *
 * The dark pair is not this rotated darker but a genuinely deep version: white
 * numerals have to stay the brightest thing on the card, and full-strength
 * `#12a95d` behind them is close to competing.
 */
export const adminHero = {
  dark: { from: "#0b3f2a", to: "#06301f" },
  light: { from: "#0a8a4b", to: "#046b48" },
} as const;

/** Splash background, duplicated in app.json — Expo reads that one before JS boots. */
export const SPLASH_BACKGROUND = { dark: "#0c0a09", light: "#ffffff" } as const;

export const radius = { card: 16, control: 10, sheet: 24 } as const;

export const spacing = { lg: 24, md: 16, sm: 8, xl: 32, xs: 4, xxl: 48 } as const;
