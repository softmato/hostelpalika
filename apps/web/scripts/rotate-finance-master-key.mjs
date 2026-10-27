/**
 * Rewrap every finance secret under a new master key.
 *
 * Block 6 item 6.0 of docs/FINANCE_IMPLEMENTATION_PLAN.md (ADR-6, D5).
 *
 * **This does not re-encrypt any secret.** Envelope encryption means each secret
 * has its own data key and only that data key is wrapped by the master key, so
 * rotation rewrites N wrapped 32-byte keys and leaves every ciphertext exactly
 * as it was. That is what makes rotating a key a job somebody actually runs
 * rather than one that gets scheduled and postponed forever.
 *
 * Procedure:
 *
 *   1. Move the current key to `FINANCE_MASTER_KEY_PREVIOUS`.
 *   2. Put the new key in `FINANCE_MASTER_KEY`. Generate it with
 *      `openssl rand -base64 32`.
 *   3. Deploy with **both** set. Nothing breaks: rows wrapped by either key
 *      still open, which is the whole reason the previous key is accepted.
 *   4. Run this script.
 *   5. Once it reports zero rows remaining on the old key, drop
 *      `FINANCE_MASTER_KEY_PREVIOUS` and deploy again.
 *
 * Resumable and idempotent — it only selects rows not already on the current
 * key, so a run that dies halfway is re-run rather than unpicked. A row no
 * configured key can open is **counted and left alone**, never deleted: an
 * unreadable secret is not a gone secret, and an operator who finds the missing
 * key can still recover it.
 *
 *   npm --prefix apps/web run rotate:finance-key -- --dry-run
 *
 * Use that form, not the root `web:rotate:finance-key` alias — the extra npm
 * layer swallows the flag, and a silently-not-dry run is a real write.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import nextEnv from "@next/env";
import mongoose from "mongoose";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dirname, "../../..");

nextEnv.loadEnvConfig(repoRoot);

if (!process.env.MONGODB_URI) {
  throw new Error("MONGODB_URI is required to rotate the finance master key.");
}

if (!process.env.FINANCE_MASTER_KEY) {
  throw new Error("FINANCE_MASTER_KEY (the new key) is required.");
}

const dryRun = process.argv.includes("--dry-run") || process.argv.includes("--dry");
const log = (message) => console.log(`${dryRun ? "[dry] " : ""}${message}`);

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const ENVELOPE_FORMAT = "v1";

function parseKey(raw, label) {
  const trimmed = raw.trim();
  const candidate = /^[a-f\d]{64}$/i.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");

  if (candidate.length !== 32) {
    throw new Error(`${label} must be 32 bytes, hex or base64.`);
  }

  return candidate;
}

/** Must match `keyIdFor` in secret-store.ts, or every row claims the wrong key. */
const keyIdOf = (raw) =>
  createHash("sha256").update(raw.trim()).digest("hex").slice(0, 12);

const target = {
  id: keyIdOf(process.env.FINANCE_MASTER_KEY),
  key: parseKey(process.env.FINANCE_MASTER_KEY, "FINANCE_MASTER_KEY"),
};
const candidates = [target];

if (process.env.FINANCE_MASTER_KEY_PREVIOUS) {
  candidates.push({
    id: keyIdOf(process.env.FINANCE_MASTER_KEY_PREVIOUS),
    key: parseKey(
      process.env.FINANCE_MASTER_KEY_PREVIOUS,
      "FINANCE_MASTER_KEY_PREVIOUS",
    ),
  });
} else {
  log(
    "FINANCE_MASTER_KEY_PREVIOUS is not set — only rows already readable by the current key can be rewrapped.",
  );
}

await mongoose.connect(process.env.MONGODB_URI);

/**
 * Rewraps one kind of envelope. `rows` yields `{ id, envelope, aad, label }`
 * and `write` stores the new wrapped key back where the envelope lives.
 */
async function rewrapAll(kind, rows, write) {
  const stale = rows.filter((row) => row.envelope?.keyId !== target.id);

  log(`${stale.length} ${kind} not wrapped by ${target.id}.`);

  let rewrapped = 0;
  let failed = 0;

  for (const row of stale) {
    const aad = Buffer.from(row.aad, "utf8");

    // Try the row's declared key first, then the others. `keyId` is a hint for
    // ordering, never an authority — it is stored data, and the auth tag decides.
    const ordered = [
      ...candidates.filter((one) => one.id === row.envelope.keyId),
      ...candidates.filter((one) => one.id !== row.envelope.keyId),
    ];

    let dataKey = null;

    for (const candidate of ordered) {
      try {
        const unwrapper = createDecipheriv(
          ALGORITHM,
          candidate.key,
          Buffer.from(row.envelope.wrappedKeyIv, "base64"),
        );

        unwrapper.setAAD(aad);
        unwrapper.setAuthTag(Buffer.from(row.envelope.wrappedKeyTag, "base64"));

        dataKey = Buffer.concat([
          unwrapper.update(Buffer.from(row.envelope.wrappedKey, "base64")),
          unwrapper.final(),
        ]);
        break;
      } catch {
        // Wrong key for this row. Try the next.
      }
    }

    if (!dataKey) {
      failed += 1;
      log(`  ! ${row.label} is wrapped by ${row.envelope.keyId}, which is not configured. Left untouched.`);
      continue;
    }

    const wrapIv = randomBytes(IV_BYTES);
    const wrapper = createCipheriv(ALGORITHM, target.key, wrapIv);

    wrapper.setAAD(aad);

    const wrappedKey = Buffer.concat([wrapper.update(dataKey), wrapper.final()]);

    dataKey.fill(0);

    if (!dryRun) {
      await write(row.id, {
        keyId: target.id,
        wrappedKey: wrappedKey.toString("base64"),
        wrappedKeyIv: wrapIv.toString("base64"),
        wrappedKeyTag: wrapper.getAuthTag().toString("base64"),
      });
    }

    rewrapped += 1;
    log(`  ✓ ${row.label}`);
  }

  return { failed, remaining: stale.length - rewrapped, rewrapped };
}

const secrets = mongoose.connection.db.collection("encryptedsecrets");
const payoutAccounts = mongoose.connection.db.collection("hostelpayoutaccounts");
const bookings = mongoose.connection.db.collection("bookings");
const backups = mongoose.connection.db.collection("hostelbackups");

// Mirrors `scopeOf` in secret-store.ts, where the provider is folded into the
// purpose. If that composition changes, this line changes with it — a script
// cannot import the TypeScript module, so both sides carry this note.
const secretResult = await rewrapAll(
  "gateway secret(s)",
  (await secrets.find({}).toArray()).map((row) => ({
    aad: `${ENVELOPE_FORMAT}:${row.hostelId.toString()}:${row.provider}:${row.purpose}`,
    envelope: row,
    id: row._id,
    label: `${row.provider} ${row.purpose} for hostel ${row.hostelId}`,
  })),
  (id, wrapped) => secrets.updateOne({ _id: id }, { $set: wrapped }),
);

// Mirrors `scopeFor` in bookings/payout-account.service.ts.
const payoutResult = await rewrapAll(
  "payout account number(s)",
  (await payoutAccounts.find({}).toArray()).map((row) => ({
    aad: `${ENVELOPE_FORMAT}:${row.hostelId.toString()}:PAYOUT_ACCOUNT_NUMBER`,
    envelope: row.number,
    id: row._id,
    label: `payout account for hostel ${row.hostelId}`,
  })),
  (id, wrapped) =>
    payoutAccounts.updateOne(
      { _id: id },
      {
        $set: Object.fromEntries(
          Object.entries(wrapped).map(([key, value]) => [`number.${key}`, value]),
        ),
      },
    ),
);

// Mirrors `refundScope` in bookings/booking.service.ts.
const refundResult = await rewrapAll(
  "booking refund account number(s)",
  (await bookings.find({ "refundAccount.number": { $exists: true } }).toArray()).map((row) => ({
    aad: `${ENVELOPE_FORMAT}:${row._id.toString()}:BOOKING_REFUND_ACCOUNT`,
    envelope: row.refundAccount.number,
    id: row._id,
    label: `refund account on booking ${row.code}`,
  })),
  (id, wrapped) =>
    bookings.updateOne(
      { _id: id },
      {
        $set: Object.fromEntries(
          Object.entries(wrapped).map(([key, value]) => [`refundAccount.number.${key}`, value]),
        ),
      },
    ),
);

// Mirrors `TOKEN_PURPOSE` in backup/backup.service.ts — the Drive refresh token.
const driveResult = await rewrapAll(
  "Drive backup token(s)",
  (await backups.find({ "drive.token": { $exists: true } }).toArray()).map((row) => ({
    aad: `${ENVELOPE_FORMAT}:${row.hostelId.toString()}:DRIVE_REFRESH_TOKEN`,
    envelope: row.drive.token,
    id: row._id,
    label: `Drive token for hostel ${row.hostelId}`,
  })),
  (id, wrapped) =>
    backups.updateOne(
      { _id: id },
      { $set: Object.fromEntries(Object.entries(wrapped).map(([key, value]) => [`drive.token.${key}`, value])) },
    ),
);

const rewrapped = secretResult.rewrapped + payoutResult.rewrapped + refundResult.rewrapped + driveResult.rewrapped;
const failed = secretResult.failed + payoutResult.failed + refundResult.failed + driveResult.failed;
const remaining = dryRun
  ? secretResult.remaining + payoutResult.remaining + refundResult.remaining + driveResult.remaining
  : (await secrets.countDocuments({ keyId: { $ne: target.id } })) +
    (await payoutAccounts.countDocuments({ "number.keyId": { $ne: target.id } })) +
    (await bookings.countDocuments({
      "refundAccount.number": { $exists: true },
      "refundAccount.number.keyId": { $ne: target.id },
    })) +
    (await backups.countDocuments({ "drive.token": { $exists: true }, "drive.token.keyId": { $ne: target.id } }));

console.table([
  { metric: "rewrapped", value: rewrapped },
  { metric: "unreadable (left alone)", value: failed },
  { metric: "still on an old key", value: remaining },
]);

if (failed > 0) {
  console.warn(
    "\nSome envelopes could not be opened by any configured key. They were NOT deleted.\n" +
      "Find the master key that wrapped them, set it as FINANCE_MASTER_KEY_PREVIOUS, and re-run.\n" +
      "Until then those hostels cannot take gateway payments or be paid out.",
  );
}

if (remaining === 0 && !dryRun) {
  console.log("\nEverything is on the current key. FINANCE_MASTER_KEY_PREVIOUS can now be removed.");
}

await mongoose.disconnect();
