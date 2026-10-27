/**
 * Restore drill for the platform backup (docs/BACKUP.md, FIELD_REVIEW I2).
 *
 * Runs on the owner's own machine — the only place the age private key lives.
 * Downloads one archive, checks its SHA-256 against its manifest, decrypts it
 * with `age` straight into `mongorestore` against a SEPARATE database (a spare
 * Atlas M0 in another project), renamed into `restore_check.*`, then compares
 * every collection's count with the manifest. Prints counts only.
 *
 * It does NOT read the repo's `.env` (that is prod). Everything comes from the
 * shell, on purpose:
 *
 *   DRILL_R2_ENDPOINT, DRILL_R2_ACCESS_KEY_ID, DRILL_R2_SECRET_ACCESS_KEY, DRILL_R2_BUCKET
 *   DRILL_AGE_KEY       path to hostelpalika-backup.key
 *   DRILL_SOURCE_DB     the prod database name inside the archive
 *   DRILL_TARGET_URI    the spare cluster — never prod
 *   DRILL_REPORT_URL    optional: https://hostelpalika.com/api/v1/cron/platform-backup
 *   CRON_SECRET         optional: with DRILL_REPORT_URL, posts the result for the status row
 *
 *   node apps/web/scripts/backup-drill.mjs [daily/<file>.archive.gz.age]   (default: latest)
 *
 * Needs `age` and `mongorestore` (MongoDB Database Tools) on PATH.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import mongoose from "mongoose";

const RESTORE_DB = "restore_check";
const env = (name) => {
  const value = process.env[name];

  if (!value) throw new Error(`${name} is not set — see the top of this script.`);

  return value;
};

const target = env("DRILL_TARGET_URI");
const hostOf = (uri) => uri.replace(/^mongodb(\+srv)?:\/\/([^@]*@)?/, "").split(/[/?]/)[0];

if (process.env.MONGODB_URI && hostOf(process.env.MONGODB_URI) === hostOf(target)) {
  throw new Error("DRILL_TARGET_URI is the same cluster as MONGODB_URI. A drill never restores into prod.");
}

const s3 = new S3Client({
  credentials: { accessKeyId: env("DRILL_R2_ACCESS_KEY_ID"), secretAccessKey: env("DRILL_R2_SECRET_ACCESS_KEY") },
  endpoint: env("DRILL_R2_ENDPOINT"),
  region: "auto",
});
const bucket = env("DRILL_R2_BUCKET");
const get = async (key) => (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))).Body;

const work = await mkdtemp(path.join(tmpdir(), "hp-drill-"));

try {
  const latest = JSON.parse(await (await get("latest.json")).transformToString());
  const key = process.argv[2] ?? `daily/${latest.file}`;
  const manifest = process.argv[2] ? JSON.parse(await (await get(`${key}.json`)).transformToString()) : latest;
  const file = path.join(work, path.basename(key));

  console.log(`Drill: ${key}`);
  await pipeline(await get(key), createWriteStream(file));

  const hash = createHash("sha256");

  await pipeline(createReadStream(file), hash);

  if (hash.digest("hex") !== manifest.sha256) throw new Error("SHA-256 does not match the manifest — the file is damaged or not ours.");

  // Plaintext only ever flows through the pipe between age and mongorestore.
  const sourceDb = env("DRILL_SOURCE_DB");
  const age = spawn("age", ["-d", "-i", env("DRILL_AGE_KEY"), file], { stdio: ["ignore", "pipe", "inherit"] });
  const restore = spawn(
    "mongorestore",
    [`--uri=${target}`, "--archive", "--gzip", "--drop", `--nsFrom=${sourceDb}.*`, `--nsTo=${RESTORE_DB}.*`, "--quiet"],
    { stdio: ["pipe", "ignore", "inherit"] },
  );

  age.stdout.pipe(restore.stdin);
  await Promise.all([
    new Promise((resolve, reject) => age.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`age exited with ${code}`))))),
    new Promise((resolve, reject) =>
      restore.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`mongorestore exited with ${code}`)))),
    ),
  ]);

  await mongoose.connect(target, { autoCreate: false, autoIndex: false });

  const db = mongoose.connection.useDb(RESTORE_DB).db;
  const mismatches = [];

  for (const [collection, expected] of Object.entries(manifest.collections)) {
    const actual = await db.collection(collection).countDocuments();

    if (actual !== expected) mismatches.push({ actual, collection, expected });
  }

  await mongoose.disconnect();

  const ok = mismatches.length === 0;

  console.table(mismatches.length ? mismatches : [{ collections: Object.keys(manifest.collections).length, result: "all counts match" }]);
  console.log(ok ? "PASSED" : "FAILED");

  if (process.env.DRILL_REPORT_URL) {
    const response = await fetch(process.env.DRILL_REPORT_URL, {
      body: JSON.stringify({ kind: "DRILL", manifest, mismatches, ok }),
      headers: { "content-type": "application/json", "x-cron-secret": env("CRON_SECRET") },
      method: "POST",
    });

    console.log(response.ok ? "Reported to the status row." : `Report failed (${response.status}).`);
  }

  process.exitCode = ok ? 0 : 1;
} finally {
  await rm(work, { force: true, recursive: true });
}

