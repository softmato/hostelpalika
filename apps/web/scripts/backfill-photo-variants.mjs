/**
 * Give every existing hostel photo its 640px WebP card copy.
 *
 * New photos get one after upload (`attachPhotoVariant` in
 * hostel-profile.service). Photos uploaded before that still serve the camera
 * original to every listing card — megabytes per card on a phone. This makes
 * the same variants `lib/image-optimizer` makes and records `photos.mediumUrl`.
 *
 * Raw driver, not the models: Node's ESM loader does not see `models` among
 * mongoose's CommonJS exports (see backfill-hostel-map-pins.mjs).
 *
 * Dry by default; pass --apply to write:
 *
 *   npm --prefix apps/web run backfill:photo-variants
 *   npm --prefix apps/web run backfill:photo-variants -- --apply
 */
import nextEnv from "@next/env";
import mongoose from "mongoose";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { optimizeImage } from "@/lib/image-optimizer";
import { getPublicUrl, publicBucket } from "@/lib/r2";

const dirname = path.dirname(fileURLToPath(import.meta.url));
nextEnv.loadEnvConfig(path.resolve(dirname, "../../.."));

if (!process.env.MONGODB_URI) {
  throw new Error("MONGODB_URI is required to run the photo variant backfill.");
}

const apply = process.argv.includes("--apply");
const log = (message) => console.log(`${apply ? "" : "[dry] "}${message}`);

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;
const hostels = db.collection("hostels");
const assets = db.collection("fileassets");
const bucket = publicBucket();

let made = 0;
let skipped = 0;

const cursor = hostels.find(
  { isDeleted: { $ne: true }, "photos.fileAssetId": { $exists: true } },
  { projection: { name: 1, photos: 1 } },
);

for await (const hostel of cursor) {
  for (const photo of hostel.photos ?? []) {
    if (!photo.fileAssetId || photo.mediumUrl) continue;

    const asset = await assets.findOne({ _id: photo.fileAssetId, isDeleted: { $ne: true } });

    if (!asset || asset.bucket !== bucket || !String(asset.mimeType ?? "").startsWith("image/")) {
      skipped += 1;
      continue;
    }

    let medium = (asset.variants ?? []).find((variant) => variant.variant === "MEDIUM");

    if (!medium && apply) {
      const variants = await optimizeImage(asset.bucket, asset.key, asset.mimeType);
      medium = variants.find((variant) => variant.variant === "MEDIUM");
      if (medium) await assets.updateOne({ _id: asset._id }, { $set: { variants } });
    }

    log(`${hostel.name}: ${asset.key} → ${medium ? medium.key : "(variants to make)"}`);

    if (apply && medium) {
      await hostels.updateOne(
        { _id: hostel._id },
        { $set: { "photos.$[photo].mediumUrl": getPublicUrl(medium.key) } },
        { arrayFilters: [{ "photo.fileAssetId": asset._id }] },
      );
    }
    made += 1;
  }
}

log(`${made} photo(s) ${apply ? "given" : "need"} a card copy; ${skipped} skipped (private, missing or not an image).`);
if (apply && made > 0) console.log("Public pages are cached: they pick this up on their next revalidation.");
await mongoose.disconnect();
