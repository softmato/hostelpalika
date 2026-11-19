/**
 * The Go guide module's parity goldens, written by the TS functions it ports:
 *   npx tsx scripts/guide-golden.ts
 * reads server/internal/modules/guide/testdata/content.json (a made-up fixture,
 * not the real guide) and writes one <reader>.json per reader beside it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { guideForReader, guidePictureName, lockedGroups, parseGuideContent, withPictureUrls, type GuideReader } from "../packages/shared/src/guide/guide";

const dir = join(__dirname, "../server/internal/modules/guide/testdata");
const content = parseGuideContent(readFileSync(join(dir, "content.json"), "utf8"));

for (const reader of ["visitor", "resident", "warden", "owner"] as GuideReader[]) {
  const out = {
    guide: withPictureUrls(guideForReader(content, reader), (src) => `signed:${guidePictureName(src)}`),
    locked: lockedGroups(content, reader),
  };
  writeFileSync(join(dir, `${reader}.json`), `${JSON.stringify(out)}\n`);
}
console.log("goldens written");
