/**
 * Puts the founders' signatures and the company stamp in the **private** R2
 * bucket, where the agreement renderer reads them (`agreement-seals.ts`).
 *
 *   npm run upload:agreement-seals -- <folder>
 *
 * `<folder>` holds `stamp.png`, `signature-jiwan.png` and `signature-siddhant.png`
 * — transparent PNGs, ink only. Keep that folder out of the repo: it is public.
 * Re-run to replace one; a server instance picks the new files up on its next
 * cold start.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { PutObjectCommand } from "@aws-sdk/client-s3";
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(path.resolve(import.meta.dirname, "../../.."));

const { getR2Client, privateBucket, withKeyPrefix } = await import("@/lib/r2");
const { AGREEMENT_SEAL_KEY, AGREEMENT_SIGNERS, AGREEMENT_STAMP_FILE } = await import("@/modules/hostels/agreement-seals");

const folder = process.argv[2];

if (!folder) throw new Error("Pass the folder that holds the PNGs.");

for (const file of [AGREEMENT_STAMP_FILE, ...AGREEMENT_SIGNERS.map((signer) => signer.file)]) {
  const body = readFileSync(path.join(folder, file));

  if (body.subarray(1, 4).toString() !== "PNG") throw new Error(`${file} is not a PNG.`);

  await getR2Client().send(
    new PutObjectCommand({
      Body: body,
      Bucket: privateBucket(),
      ContentType: "image/png",
      Key: withKeyPrefix(`${AGREEMENT_SEAL_KEY}/${file}`),
    }),
  );
  console.log(`Uploaded ${file} (${body.length} bytes) to the private bucket.`);
}
