// Every glyph on one sheet, light and dark, line with its solid beside it, at
// the two sizes that matter (36 and 16). Review the set here, not one icon at a
// time — drift only shows when they stand together.
//
//   node --experimental-strip-types packages/shared/scripts/glyph-sheet.ts [out.png]
//
// Writes docs/mockups/icons/glyph-sheet.png by default. Needs `sharp` (root).
import { createRequire } from "node:module";

import { GLYPHS, type GlyphName, SOLID_GLYPHS } from "../src/constants/glyphs.ts";

const require = createRequire(import.meta.url);
const sharp = require("sharp");

const out = process.argv[2] ?? new URL("../../../docs/mockups/icons/glyph-sheet.png", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const names = Object.keys(GLYPHS) as GlyphName[];
const cols = 10, cellW = 128, cellH = 84, pad = 24;
const half = pad * 2 + Math.ceil(names.length / cols) * cellH;
const W = pad * 2 + cols * cellW;

function icon(name: GlyphName, x: number, y: number, size: number, ink: string, solid: boolean): string {
  const paths = solid ? SOLID_GLYPHS[name] : GLYPHS[name];
  if (!paths) return "";
  const body = paths.map((d) => `<path d="${d}"${solid ? ' fill-rule="evenodd"' : ""}/>`).join("");
  const paint = solid
    ? `fill="${ink}"`
    : `fill="none" stroke="${ink}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"`;
  return `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 24 24" ${paint}>${body}</svg>`;
}

let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${half * 2}">`;
[
  { bg: "#ffffff", brand: "#0a8a4b", ink: "#0a0a0a", muted: "#777777" },
  { bg: "#0b0c0b", brand: "#12a95d", ink: "#f5f5f5", muted: "#8a8a8a" },
].forEach((theme, t) => {
  const top = t * half;
  svg += `<rect y="${top}" width="${W}" height="${half}" fill="${theme.bg}"/>`;
  names.forEach((name, i) => {
    const x = pad + (i % cols) * cellW, y = top + pad + Math.floor(i / cols) * cellH;
    svg += icon(name, x, y, 36, theme.ink, false) + icon(name, x + 44, y + 10, 16, theme.ink, false);
    svg += icon(name, x + 70, y, 36, theme.brand, true);
    svg += `<text x="${x}" y="${y + 56}" font-family="Segoe UI, Arial" font-size="10" fill="${theme.muted}">${name}</text>`;
  });
});

await sharp(Buffer.from(`${svg}</svg>`), { density: 96 }).png().toFile(out);
console.log(`${names.length} glyphs (${Object.keys(SOLID_GLYPHS).length} solid) → ${out}`);
