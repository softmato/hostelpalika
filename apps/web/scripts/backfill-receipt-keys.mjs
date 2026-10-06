/**
 * Stamp `receiptGroupId` + `receiptHash` on shared-receipt expenses saved before
 * the duplicate check existed, so they block a re-share like every new row.
 *
 * A shared receipt is a row whose `clientRequestId` is `receipt-<sha256 prefix>`
 * with a photo. The hash is read from the photo's FileAsset (`contentHash`,
 * computed server-side), the group is the hostel's `parentHostelId` or itself.
 * The transaction id cannot be recovered without re-reading the file, so old
 * rows are matched on bytes only.
 *
 * When two standing rows already hold the same receipt in one group, the oldest
 * is stamped and the rest are left unstamped and listed — the unique index could
 * not be built over them otherwise. Void the extra rows by hand, then re-run.
 *
 * Idempotent. Run before `db:indexes`:
 *
 *   npm --prefix apps/web run backfill:receipt-keys -- --dry-run
 */
import nextEnv from "@next/env";
import mongoose from "mongoose";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
nextEnv.loadEnvConfig(path.resolve(dirname, "../../.."));

if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required to run the receipt key backfill.");

const dryRun = process.argv.includes("--dry-run") || process.argv.includes("--dry");
const log = (message) => console.log(`${dryRun ? "[dry] " : ""}${message}`);

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;
const expenses = db.collection("expenses");
const groups = new Map();

async function groupOf(hostelId) {
  const key = hostelId.toString();
  if (!groups.has(key)) {
    const hostel = await db.collection("hostels").findOne({ _id: hostelId }, { projection: { parentHostelId: 1 } });
    groups.set(key, hostel?.parentHostelId ?? hostelId);
  }
  return groups.get(key);
}

const rows = await expenses
  .find({ clientRequestId: /^receipt-[a-f0-9]{56}$/, photoAssetId: { $ne: null }, receiptHash: null })
  .project({ hostelId: 1, photoAssetId: 1, status: 1 })
  .sort({ createdAt: 1 })
  .toArray();

let stamped = 0;
const skipped = [];
// Also covers rows stamped earlier in this run, which a dry run never wrote.
const taken = new Map();

for (const row of rows) {
  const asset = await db.collection("fileassets").findOne({ _id: row.photoAssetId }, { projection: { contentHash: 1 } });
  if (!asset?.contentHash) { skipped.push(`${row._id} — photo has no hash`); continue; }
  const receiptGroupId = await groupOf(row.hostelId);
  if (row.status === "RECORDED") {
    const key = `${receiptGroupId}:${asset.contentHash}`;
    const holder = taken.get(key)
      ?? (await expenses.findOne({ receiptGroupId, receiptHash: asset.contentHash, status: "RECORDED", _id: { $ne: row._id } }))?._id;
    if (holder) { skipped.push(`${row._id} — same receipt as ${holder}; void one of them`); continue; }
    taken.set(key, row._id);
  }
  if (!dryRun) await expenses.updateOne({ _id: row._id }, { $set: { receiptGroupId, receiptHash: asset.contentHash } });
  stamped += 1;
}

log(`${rows.length} shared-receipt expenses without keys, ${stamped} stamped.`);
for (const line of skipped) log(`skipped ${line}`);
await mongoose.disconnect();
