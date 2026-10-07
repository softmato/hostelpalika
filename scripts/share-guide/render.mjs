// Renders scripts/share-guide/steps.html into the step pictures the app and the
// website show under "See how to share your receipt". Needs Playwright with a
// Chromium: `npx -y playwright@1 --version` is enough to fetch it locally.
//
//   node scripts/share-guide/render.mjs
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

const app = join(root, "apps/mobile/assets/images/share-guide");
const web = join(root, "apps/web/public/share-guide");
mkdirSync(app, { recursive: true });
mkdirSync(web, { recursive: true });

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { height: 700, width: 1500 } });
await page.goto(pathToFileURL(join(here, "steps.html")).href);
await page.evaluate(() => document.fonts.ready);

for (const step of [1, 2, 3, 4]) {
  const out = join(app, `step-${step}.png`);
  await page.locator(`#step-${step}`).screenshot({ omitBackground: true, path: out });
  copyFileSync(out, join(web, `step-${step}.png`));
  console.log(`step-${step}.png`);
}

await browser.close();
