/**
 * Writes catalogue.json: every index the TS (Mongoose) schemas declare, per
 * collection. cmd/indexes builds from that file, so it keeps working once TS is
 * gone. Re-run after a TS schema change, until cut-over (PARITY.md §2 intake):
 *
 *   cd apps/web && node --experimental-transform-types --import ./scripts/register-ts-hook.mjs ../server/internal/platform/indexes/dump-ts.mjs
 */
import mongoose from "mongoose";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { loadModelCatalogue } from "../../../../apps/web/scripts/model-catalogue.mjs";

await loadModelCatalogue();

const out = [];
for (const model of Object.values(mongoose.models).sort((a, b) => a.collection.collectionName.localeCompare(b.collection.collectionName))) {
  const collation = model.schema.options.collation;
  for (const [keys, opts] of model.schema.indexes()) {
    const options = { ...opts };
    delete options.background; // a no-op since MongoDB 4.2
    if (collation && !options.collation) options.collation = collation;
    out.push({ collection: model.collection.collectionName, keys: Object.entries(keys), options });
  }
}

const file = fileURLToPath(new URL("./catalogue.json", import.meta.url));
await writeFile(file, JSON.stringify(out, null, 1) + "\n");
console.log(`${out.length} indexes written to ${file}`);
