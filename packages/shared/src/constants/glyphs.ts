/**
 * HostelPalika's own line icons — drawn here, not pulled from a set, so the
 * branch and Overall surfaces read as one hand on web and in the app.
 *
 * Every glyph is a list of stroke-only paths on a 24×24 grid: round caps and
 * joins, no fills, coloured by whoever renders it (a theme token, never a hex).
 * Web renders them with `<Glyph>` in `apps/web/src/components/glyph.tsx`, the
 * app with `apps/mobile/src/components/ui/glyph.tsx`.
 */
export const GLYPHS = {
  overall: [
    "M12 3.5 3.5 8 12 12.5 20.5 8Z",
    "M3.5 12 12 16.5 20.5 12",
    "M3.5 16 12 20.5 20.5 16",
  ],
  hostel: [
    "M4.5 20.5V7a1.3 1.3 0 0 1 .9-1.2l6-2.1a1.3 1.3 0 0 1 1.7 1.2v15.6",
    "M13.1 9.5h5.1a1.3 1.3 0 0 1 1.3 1.3v9.7",
    "M3 20.5h18",
    "M8 9h1.5M8 12.5h1.5M8 16h1.5M16 13.5h.5M16 17h.5",
  ],
  branch: [
    "M6 3.5v10",
    "M8.5 17a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z",
    "M20.5 6.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z",
    "M18 9c0 4.6-3.4 6.6-9.4 7.6",
  ],
  people: [
    "M15 7.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
    "M5.5 19.5c.8-3.2 3.4-5 6.5-5s5.7 1.8 6.5 5",
  ],
  money: [
    "M4 7.5A2.5 2.5 0 0 1 6.5 5h11A2.5 2.5 0 0 1 20 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5Z",
    "M4 9.5h16",
    "M15.5 14h1",
  ],
  daily: [
    "M8.5 5H7a2 2 0 0 0-2 2v11.5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-1.5",
    "M9 3.5h6v3H9Z",
    "M9 13.5l2 2 4-4.5",
  ],
  reports: [
    "M4.5 19.5h15",
    "M7.5 16v-4",
    "M12 16V8",
    "M16.5 16v-6.5",
  ],
  bed: [
    "M3.5 18.5v-12",
    "M3.5 14h17v4.5",
    "M20.5 14v-2.5A2.5 2.5 0 0 0 18 9h-7v5",
    "M8.5 11a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z",
  ],
  screens: [
    "M4.5 4.5h6v6h-6Z",
    "M13.5 4.5h6v6h-6Z",
    "M4.5 13.5h6v6h-6Z",
    "M13.5 13.5h6v6h-6Z",
  ],
  pin: [
    "M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z",
    "M14.2 10a2.2 2.2 0 1 1-4.4 0 2.2 2.2 0 0 1 4.4 0Z",
  ],
  open: ["M8 16 16 8", "M9.5 8H16v6.5"],
  check: ["M5 12.5l4.5 4.5L19 7.5"],
  chevron: ["M9.5 6l6 6-6 6"],
  chevronDown: ["M6 9.5l6 6 6-6"],
  plus: ["M12 5v14", "M5 12h14"],
} as const;

export type GlyphName = keyof typeof GLYPHS;
