/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,jsx,ts,tsx}"],
  /*
   * Class, not media.
   *
   * The app owns the theme: `useAppTheme` pushes the user's stored preference
   * into NativeWind on every render. NativeWind refuses that push while dark
   * mode is `media` ("Unable to manually set color scheme without using
   * darkMode: class"), which on web threw out of the effect and took the whole
   * tree down with it. Class also means the browser stops deciding: with
   * `media`, an OS-dark phone got the dark `:root` variables even when the user
   * had chosen Light, so the JS palette and the CSS one disagreed.
   */
  darkMode: "class",
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        background: "rgb(var(--background) / <alpha-value>)",
        foreground: "rgb(var(--foreground) / <alpha-value>)",
        card: {
          DEFAULT: "rgb(var(--card) / <alpha-value>)",
          foreground: "rgb(var(--card-foreground) / <alpha-value>)",
        },
        popover: {
          DEFAULT: "rgb(var(--popover) / <alpha-value>)",
          foreground: "rgb(var(--popover-foreground) / <alpha-value>)",
        },
        primary: {
          DEFAULT: "rgb(var(--primary) / <alpha-value>)",
          foreground: "rgb(var(--primary-foreground) / <alpha-value>)",
        },
        secondary: {
          DEFAULT: "rgb(var(--secondary) / <alpha-value>)",
          foreground: "rgb(var(--secondary-foreground) / <alpha-value>)",
        },
        muted: {
          DEFAULT: "rgb(var(--muted) / <alpha-value>)",
          foreground: "rgb(var(--muted-foreground) / <alpha-value>)",
        },
        accent: {
          DEFAULT: "rgb(var(--accent) / <alpha-value>)",
          foreground: "rgb(var(--accent-foreground) / <alpha-value>)",
        },
        destructive: {
          DEFAULT: "rgb(var(--destructive) / <alpha-value>)",
          foreground: "rgb(var(--destructive-foreground) / <alpha-value>)",
          soft: "rgb(var(--destructive-soft) / <alpha-value>)",
        },
        border: "rgb(var(--border) / <alpha-value>)",
        input: "rgb(var(--input) / <alpha-value>)",
        ring: "rgb(var(--ring) / <alpha-value>)",

        surface: {
          DEFAULT: "rgb(var(--surface) / <alpha-value>)",
          strong: "rgb(var(--surface-strong) / <alpha-value>)",
        },
        warning: {
          DEFAULT: "rgb(var(--warning) / <alpha-value>)",
          soft: "rgb(var(--warning-soft) / <alpha-value>)",
        },
        success: {
          DEFAULT: "rgb(var(--success) / <alpha-value>)",
          soft: "rgb(var(--success-soft) / <alpha-value>)",
        },
        info: {
          DEFAULT: "rgb(var(--info) / <alpha-value>)",
          soft: "rgb(var(--info-soft) / <alpha-value>)",
        },
        brand: {
          DEFAULT: "rgb(var(--brand) / <alpha-value>)",
          soft: "rgb(var(--brand-soft) / <alpha-value>)",
        },
        role: {
          platform: "rgb(var(--role-platform) / <alpha-value>)",
          "platform-soft": "rgb(var(--role-platform-soft) / <alpha-value>)",
          admin: "rgb(var(--role-admin) / <alpha-value>)",
          "admin-soft": "rgb(var(--role-admin-soft) / <alpha-value>)",
          resident: "rgb(var(--role-resident) / <alpha-value>)",
          "resident-soft": "rgb(var(--role-resident-soft) / <alpha-value>)",
          guardian: "rgb(var(--role-guardian) / <alpha-value>)",
          "guardian-soft": "rgb(var(--role-guardian-soft) / <alpha-value>)",
          cook: "rgb(var(--role-cook) / <alpha-value>)",
          "cook-soft": "rgb(var(--role-cook-soft) / <alpha-value>)",
          provider: "rgb(var(--role-provider) / <alpha-value>)",
          "provider-soft": "rgb(var(--role-provider-soft) / <alpha-value>)",
        },
      },
      borderRadius: {
        DEFAULT: "10px",
        card: "16px",
        sheet: "24px",
      },
    },
  },
  plugins: [],
};
