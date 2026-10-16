/**
 * A flat vector character per trade, and the colours their card is drawn in.
 *
 * ## Why inline SVG and not an icon or an image file
 *
 * The owner asked for cards carrying pictures of the tradespeople — a plumber, a
 * doctor — rather than eleven variations of the same grey glyph. A glyph
 * wrench is not a plumber, and there are no illustration assets in this repo to
 * reach for.
 *
 * `react-native-svg` would be the obvious answer and is **not installed**, and
 * adding it is a native module: the dev build already on the phone would not
 * have it, and every JS reload would crash until the APK was rebuilt. `expo-image`
 * already renders SVG on both platforms (androidsvg on Android, the SVG coder on
 * iOS) and is already a dependency, so a `data:` URI costs nothing to ship and
 * works in the build that is installed today.
 *
 * ## Composed, not eleven hand-drawn blobs
 *
 * Every figure is the same bust — a tinted disc, a head, hair, shoulders — with
 * the trade's own uniform colour and one prop. That is what keeps the deck
 * looking like one set rather than eleven clip-art downloads, and it is why
 * adding a twelfth trade is three lines rather than an illustration brief.
 *
 * ## About the colour
 *
 * `docs/DESIGN.md` and `CLAUDE.md` are emphatic that the app is black, white and
 * green, and these cards are the one deliberate exception, asked for directly on
 * 2026-09-02: *"colourful card swappable"*. The colour is confined to the
 * **illustration and its card tint** — it is doing the job of an illustration,
 * which is to be recognised at a glance from across a corridor. Every control on
 * the card, the selected state included, is still `--primary`, so nothing here
 * competes with the brand for meaning. Do not spread these hexes to chrome.
 *
 * Pure: string building and a lookup table, no React Native, so it is testable
 * node-side like every other `lib/` module.
 */

export type TradeArt = {
  /** The card's background wash. */
  tint: string;
  /** The uniform, and the strongest colour in the drawing. */
  uniform: string;
};

const SKIN = "#f2c9a0";
const SKIN_SHADE = "#e0ac7d";
const HAIR = "#3f3f46";
const WHITE = "#ffffff";
const STEEL = "#94a3b8";
const STEEL_DARK = "#64748b";

/**
 * The palette, one row per trade.
 *
 * Chosen so that any two cards next to each other in the deck are told apart by
 * hue rather than by reading the label — which is the entire point of drawing
 * them — while every tint stays pale enough that black label text on it clears
 * contrast.
 */
const PALETTE: Record<string, TradeArt> = {
  APPLIANCE: { tint: "#e2e8f0", uniform: "#475569" },
  CARPENTRY: { tint: "#fde9d0", uniform: "#b45309" },
  CLEANING: { tint: "#ccfbf1", uniform: "#0d9488" },
  ELECTRICAL: { tint: "#fef3c7", uniform: "#d97706" },
  HEALTH: { tint: "#fee2e2", uniform: "#dc2626" },
  INTERNET: { tint: "#e0e7ff", uniform: "#4f46e5" },
  OTHER: { tint: "#d9f2e5", uniform: "#0a8a4b" },
  PAINTING: { tint: "#ede9fe", uniform: "#7c3aed" },
  PLUMBING: { tint: "#dbeafe", uniform: "#2563eb" },
  ROOM_REPAIR: { tint: "#ffe4e6", uniform: "#e11d48" },
  WATER: { tint: "#e0f2fe", uniform: "#0284c7" },
};

export function tradeArt(category: string): TradeArt {
  return PALETTE[category] ?? PALETTE.OTHER;
}

/**
 * The shared figure: shoulders, neck, head, hair.
 *
 * Drawn back-to-front so nothing needs a z-index, and sized for a 96×96 box with
 * the disc already painted behind it.
 */
function bust(uniform: string, { hair = HAIR }: { hair?: string } = {}) {
  return [
    // Shoulders — a wide rounded shape cropped by the disc.
    `<path d="M20 96c0-15 12-25 28-25s28 10 28 25z" fill="${uniform}"/>`,
    // Collar, so the uniform reads as clothing rather than as a block.
    `<path d="M40 73l8 10 8-10-8-4z" fill="${WHITE}" opacity="0.9"/>`,
    `<rect x="43" y="62" width="10" height="12" rx="4" fill="${SKIN_SHADE}"/>`,
    `<circle cx="48" cy="48" r="17" fill="${SKIN}"/>`,
    // Hair as a cap over the top of the skull.
    `<path d="M31 46a17 17 0 0134 0c0-4-6-9-17-9s-17 5-17 9z" fill="${hair}"/>`,
    `<circle cx="42" cy="48" r="1.8" fill="${HAIR}"/>`,
    `<circle cx="54" cy="48" r="1.8" fill="${HAIR}"/>`,
    `<path d="M44 55q4 3 8 0" stroke="${HAIR}" stroke-width="1.6" fill="none" stroke-linecap="round"/>`,
  ].join("");
}

/** The prop each trade is holding, or wearing. */
function prop(category: string, uniform: string): string {
  switch (category) {
    case "PLUMBING":
      // A pipe wrench, held up beside the head.
      return [
        `<rect x="71" y="46" width="7" height="30" rx="3.5" fill="${STEEL}"/>`,
        `<path d="M68 40h13v9h-5v4h-8z" fill="${STEEL_DARK}"/>`,
      ].join("");
    case "ELECTRICAL":
      // A bolt on a badge — the one symbol nobody has to be taught.
      return `<path d="M78 34l-12 18h8l-4 14 13-19h-8z" fill="${uniform}" stroke="${WHITE}" stroke-width="1.5" stroke-linejoin="round"/>`;
    case "INTERNET":
      // Signal arcs rising from the shoulder.
      return [
        `<path d="M68 60a12 12 0 0114 0" stroke="${uniform}" stroke-width="3" fill="none" stroke-linecap="round"/>`,
        `<path d="M71 66a7 7 0 018 0" stroke="${uniform}" stroke-width="3" fill="none" stroke-linecap="round"/>`,
        `<circle cx="75" cy="72" r="2.5" fill="${uniform}"/>`,
      ].join("");
    case "CLEANING":
      // A broom.
      return [
        `<rect x="74" y="30" width="4" height="34" rx="2" fill="#a16207"/>`,
        `<path d="M69 64h14l3 12H66z" fill="${uniform}"/>`,
      ].join("");
    case "CARPENTRY":
      // A hammer.
      return [
        `<rect x="74" y="44" width="4" height="30" rx="2" fill="#a16207"/>`,
        `<path d="M66 38h20v10H66z" fill="${STEEL_DARK}"/>`,
      ].join("");
    case "PAINTING":
      // A roller on its handle.
      return [
        `<rect x="74" y="48" width="4" height="26" rx="2" fill="${STEEL}"/>`,
        `<rect x="66" y="34" width="20" height="12" rx="4" fill="${uniform}"/>`,
      ].join("");
    case "WATER":
      // A falling drop.
      return `<path d="M76 34c7 9 10 13 10 18a10 10 0 01-20 0c0-5 3-9 10-18z" fill="${uniform}"/>`;
    case "APPLIANCE":
      // A plug.
      return [
        `<rect x="66" y="44" width="20" height="22" rx="4" fill="${uniform}"/>`,
        `<rect x="71" y="36" width="3.5" height="10" rx="1.75" fill="${STEEL_DARK}"/>`,
        `<rect x="78" y="36" width="3.5" height="10" rx="1.75" fill="${STEEL_DARK}"/>`,
      ].join("");
    case "ROOM_REPAIR":
      // A door with its handle.
      return [
        `<rect x="66" y="36" width="20" height="34" rx="3" fill="${uniform}"/>`,
        `<circle cx="71" cy="54" r="2.5" fill="${WHITE}"/>`,
      ].join("");
    case "HEALTH":
      // A stethoscope over the shoulder, plus the cross on the chest.
      return [
        `<path d="M38 74c0 12 20 12 20 0" stroke="${WHITE}" stroke-width="3" fill="none" stroke-linecap="round"/>`,
        `<circle cx="60" cy="76" r="4" fill="${WHITE}"/>`,
        `<path d="M74 46h6v6h6v6h-6v6h-6v-6h-6v-6h6z" fill="${uniform}" stroke="${WHITE}" stroke-width="1.5"/>`,
      ].join("");
    default:
      // A toolbox, for the trade nobody named.
      return [
        `<rect x="64" y="48" width="24" height="18" rx="3" fill="${uniform}"/>`,
        `<path d="M71 48v-4h10v4" stroke="${STEEL_DARK}" stroke-width="3" fill="none" stroke-linecap="round"/>`,
      ].join("");
  }
}

/**
 * A hard hat, for the trades that wear one. Drawn over the hair.
 *
 * Health and cleaning are the two that do not, which is most of what tells those
 * two cards apart from the rest at a glance.
 */
const HELMETED = new Set([
  "APPLIANCE",
  "CARPENTRY",
  "ELECTRICAL",
  "INTERNET",
  "PAINTING",
  "PLUMBING",
  "ROOM_REPAIR",
  "WATER",
]);

function helmet(uniform: string) {
  return [
    `<path d="M30 44a18 18 0 0136 0z" fill="${uniform}"/>`,
    `<rect x="26" y="43" width="44" height="5" rx="2.5" fill="${uniform}"/>`,
    `<rect x="45" y="28" width="6" height="10" rx="3" fill="${WHITE}" opacity="0.5"/>`,
  ].join("");
}

/**
 * The whole card illustration as a `data:` URI, ready for `<Image source>`.
 *
 * Percent-encoded rather than base64: `btoa` is not reliably present in Hermes,
 * and a raw `#` inside a `data:` URI is read as a fragment marker — which is
 * exactly how every colour in the drawing would silently disappear.
 */
export function tradeArtUri(category: string): string {
  const { tint, uniform } = tradeArt(category);

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96">`,
    `<defs><clipPath id="c"><circle cx="48" cy="48" r="46"/></clipPath></defs>`,
    `<circle cx="48" cy="48" r="46" fill="${tint}"/>`,
    `<g clip-path="url(#c)">`,
    bust(uniform),
    HELMETED.has(category) ? helmet(uniform) : "",
    prop(category, uniform),
    `</g>`,
    `</svg>`,
  ].join("");

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
