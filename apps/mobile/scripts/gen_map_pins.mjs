/**
 * Draws the hostel pin the native map uses: a brand-green teardrop with a
 * white rim, the HP mark in a white disc, and a soft shadow where the tip
 * meets the ground. The mark is `assets/images/logo-mark.png`, so swapping
 * that file and re-running this is the whole rebrand.
 *
 *   node apps/mobile/scripts/gen_map_pins.mjs
 *
 * Writes `assets/images/map/hostel-pin{,-dark}{,@2x,@3x}.png`. One pin per
 * theme, because the brand green itself is one shade per theme
 * (`constants/theme.ts`). `sharp` resolves from the repo root's node_modules.
 */
import { Buffer } from "node:buffer";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, "..", "assets", "images");
const out = join(assets, "map");

/** 1x size in dp. `map-styles.ts` offsets the icon by the space under the tip. */
const WIDTH = 40;
const HEIGHT = 50;

/** Top and bottom of each theme's body gradient: the brand, then one shade deeper. */
const THEMES = {
  "hostel-pin": ["#0a8a4b", "#046b48"],
  "hostel-pin-dark": ["#12a95d", "#0a8a4b"],
};

const mark = readFileSync(join(assets, "logo-mark.png")).toString("base64");

// Circle at (20, 18) r 16; tangents from the tip at (20, 46) meet it at
// (6.87, 27.14) and (33.13, 27.14). The tip itself is rounded off.
const BODY =
  "M6.87 27.14 A16 16 0 1 1 33.13 27.14 Q26.2 37.6 21.3 44.4 Q20 46.1 18.7 44.4 Q13.8 37.6 6.87 27.14 Z";

function svg([top, bottom], scale) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH * scale}" height="${HEIGHT * scale}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="body" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${top}"/>
      <stop offset="1" stop-color="${bottom}"/>
    </linearGradient>
    <filter id="blur" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="1.1"/>
    </filter>
  </defs>
  <ellipse cx="20" cy="46.6" rx="5.5" ry="1.9" fill="#000" opacity="0.28" filter="url(#blur)"/>
  <path d="${BODY}" fill="#000" opacity="0.22" transform="translate(0 1.2)" filter="url(#blur)"/>
  <path d="${BODY}" fill="#fff" stroke="#fff" stroke-width="4" stroke-linejoin="round"/>
  <path d="${BODY}" fill="url(#body)"/>
  <circle cx="20" cy="18" r="11.2" fill="#fff"/>
  <image href="data:image/png;base64,${mark}" x="11.6" y="9.6" width="16.8" height="16.8"/>
</svg>`;
}

mkdirSync(out, { recursive: true });

for (const [name, colors] of Object.entries(THEMES)) {
  for (const scale of [1, 2, 3]) {
    const file = join(out, `${name}${scale === 1 ? "" : `@${scale}x`}.png`);
    const png = await sharp(Buffer.from(svg(colors, scale))).png().toBuffer();

    writeFileSync(file, png);
    console.log(file);
  }
}
