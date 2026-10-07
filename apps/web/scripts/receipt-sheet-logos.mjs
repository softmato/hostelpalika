// Inlines the wallet and bank marks into public/receipt-sheet.html.
//
// The sheet allows only `data:` images (its CSP) and the native web views block
// network loads, so its "Paid by" picker cannot fetch a logo: they travel inside
// the page. 64px WebP keeps all of them near 40 KB. Keys match the mobile app's
// `payment-logos` keys and the server's `receipt-labels` bank keys.
//
//   node apps/web/scripts/receipt-sheet-logos.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const images = join(web, "../mobile/assets/images");
const KEYS = {
  esewa: "wallets/esewa", khalti: "wallets/khalti", fonepay: "wallets/fonepay",
  ...Object.fromEntries([
    "agricultural-development", "citizens", "everest", "global-ime", "himalayan", "kumari",
    "laxmi-sunrise", "machhapuchchhre", "nabil", "nepal-bank", "nepal-investment-mega", "nepal-sbi",
    "nic-asia", "nmb", "prabhu", "prime-commercial", "sanima", "siddhartha", "standard-chartered",
  ].map((key) => [key, `banks/${key}`])),
};

const logos = {};
for (const [key, file] of Object.entries(KEYS)) {
  const bytes = await sharp(join(images, `${file}.png`))
    .resize(64, 64, { fit: "inside" })
    .webp({ effort: 6, quality: 82 })
    .toBuffer();
  logos[key] = `data:image/webp;base64,${bytes.toString("base64")}`;
}

const page = join(web, "public/receipt-sheet.html");
const html = readFileSync(page, "utf8");
const marker = /\/\*logos\*\/[\s\S]*?\/\*logos\*\//;
if (!marker.test(html)) throw new Error("receipt-sheet.html has no /*logos*/…/*logos*/ block");
writeFileSync(page, html.replace(marker, () => `/*logos*/${JSON.stringify(logos)}/*logos*/`));
console.log(`${Object.keys(logos).length} logos, ${JSON.stringify(logos).length} bytes`);
