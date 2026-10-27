import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { Types } from "mongoose";
import nacl from "tweetnacl";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { logger } from "@/lib/logger";
import { billingHostelId } from "@/modules/billing/billing-hostel";
import { resolveOwnedHostel } from "@/modules/billing/subscription-access";
import { openValue, sealValue } from "@/modules/finance/gateway/secret-store";
import type { SecretEnvelope } from "@/modules/finance/gateway/envelope-crypto";
import { resolveAdminHostelId } from "@/modules/hostels/hostel.service";
import { getSiteConfigSection } from "@/modules/platform-config/site-config.service";
import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { HostelBackupModel } from "@hostel/db/models/HostelBackup";
import { HostelBackupRunModel } from "@hostel/db/models/HostelBackupRun";
import { HostelSubscriptionModel } from "@hostel/db/models/HostelSubscription";
import { fromBase64, keyFingerprint, sealArchive } from "@hostel/shared/backup/sealed-archive";
import { planRank } from "@hostel/shared/plans/catalog";

import {
  deleteFromAppData,
  downloadFromAppData,
  driveAccessToken,
  driveAuthUrl,
  DriveError,
  exchangeDriveCode,
  isDriveConfigured,
  revokeDriveToken,
  uploadToAppData,
} from "./google-drive";
import {
  buildTenantExport,
  packTenantExport,
  parseChunk,
  sha256Hex,
  TENANT_COLLECTIONS,
  tenantHostelIds,
} from "./tenant-export";

/**
 * Customer backup to the owner's Google Drive (docs/FIELD_REVIEW_2026_10_27.md
 * I3–I7; threat model in docs/BACKUP.md).
 *
 * Owner only, everywhere. Connecting Drive and scheduled backups need the Pro
 * plan or above; downloading and restoring what was already backed up do not —
 * a lapsed plan must not hold a hostel's own data hostage.
 */

const PLAN_FLOOR = "pro";
/** Backups kept in Drive; older files are deleted, their history rows stay. */
const KEEP_ON_DRIVE = 30;
const STATE_TTL_MS = 10 * 60_000;
const TOKEN_PURPOSE = "DRIVE_REFRESH_TOKEN";

type Fail = { errorCode: string; status: number };
const fail = (message: string, errorCode: string, status: number) =>
  Object.assign(new Error(message), { errorCode, status } satisfies Fail);

const appUrl = () => process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
export const driveRedirectUri = () => `${appUrl()}/api/v1/hostel-admin/backup/drive/callback`;

async function ownerHostel(principal: ApiPrincipal, requestedHostelId?: string) {
  await connectToDatabase();

  const hostelId = resolveAdminHostelId(principal, requestedHostelId);

  // Only the owner: a warden runs the hostel, its whole archive is not theirs.
  await resolveOwnedHostel(hostelId.toString(), principal.userId);

  return hostelId;
}

export async function backupPlanAllows(hostelId: Types.ObjectId) {
  const subscription = await HostelSubscriptionModel.findOne({ hostelId: await billingHostelId(hostelId) })
    .select("planId")
    .lean<{ planId?: string | null } | null>();

  if (!subscription?.planId) return false;

  const catalog = await getSiteConfigSection("plans");
  const floor = planRank(catalog, PLAN_FLOOR);

  return floor >= 0 && planRank(catalog, subscription.planId) >= floor;
}

async function assertPlan(hostelId: Types.ObjectId) {
  if (!(await backupPlanAllows(hostelId))) {
    throw fail("Backup to Google Drive comes with the Pro plan and up.", "BACKUP_NEEDS_PRO", 403);
  }
}

async function audit(actorId: string | null, hostelId: Types.ObjectId, action: string, metadata: Record<string, unknown>) {
  await AuditLogModel.create({
    action,
    actorId,
    actorType: actorId ? "USER" : "SYSTEM",
    entityId: hostelId.toString(),
    entityType: "HostelBackup",
    hostelId,
    metadata,
  }).catch(() => {});
}

/* ── Overview ───────────────────────────────────────────────────────────── */

type BackupRow = {
  drive?: { connectedAt?: Date; email?: string; error?: string; status?: string };
  keyFingerprint?: string;
  keySetAt?: Date;
  kitConfirmedAt?: Date;
  lastRunAt?: Date;
  publicKey?: string;
};

type RunRow = {
  _id: Types.ObjectId;
  bytes?: number;
  checked?: boolean;
  chunks?: Array<{ collection: string; index: number; rows: number; sha256: string }>;
  counts?: Record<string, number>;
  createdAt: Date;
  driveFileId?: string;
  error?: string;
  fileName?: string;
  keyFingerprint?: string;
  sha512?: string;
  status: "OK" | "FAILED";
  trigger?: string;
};

/** `GET /hostel-admin/backup` — everything the Backup screen shows. */
export async function getBackupOverview(principal: ApiPrincipal, requestedHostelId?: string) {
  const hostelId = await ownerHostel(principal, requestedHostelId);
  const [allowed, config, runs] = await Promise.all([
    backupPlanAllows(hostelId),
    HostelBackupModel.findOne({ hostelId }).lean<BackupRow | null>(),
    HostelBackupRunModel.find({ hostelId }).sort({ createdAt: -1 }).limit(60).select("-chunks").lean<RunRow[]>(),
  ]);

  return {
    allowed,
    drive: {
      connectedAt: config?.drive?.connectedAt?.toISOString() ?? null,
      email: config?.drive?.email ?? null,
      error: config?.drive?.error ?? null,
      ready: isDriveConfigured(),
      status: config?.drive?.status ?? "NOT_CONNECTED",
    },
    hostelId: hostelId.toString(),
    key: config?.publicKey
      ? {
          fingerprint: config.keyFingerprint ?? null,
          kitConfirmedAt: config.kitConfirmedAt?.toISOString() ?? null,
          setAt: config.keySetAt?.toISOString() ?? null,
        }
      : null,
    runs: runs.map((run) => ({
      bytes: run.bytes ?? null,
      checked: Boolean(run.checked),
      counts: run.counts ?? {},
      createdAt: run.createdAt.toISOString(),
      error: run.error ?? null,
      fileName: run.fileName ?? null,
      id: run._id.toString(),
      keyFingerprint: run.keyFingerprint ?? null,
      onDrive: Boolean(run.driveFileId),
      sha512: run.sha512 ?? null,
      status: run.status,
      trigger: run.trigger ?? "SCHEDULE",
    })),
  };
}

/* ── Key ────────────────────────────────────────────────────────────────── */

/**
 * The public half of the key the owner's phone made. Replacing it means older
 * backups still need the older recovery kit — each run records its key's
 * fingerprint so the screen can say which.
 */
export async function setBackupKey(principal: ApiPrincipal, requestedHostelId: string | undefined, publicKey: string) {
  const hostelId = await ownerHostel(principal, requestedHostelId);
  const bytes = fromBase64(publicKey);

  if (bytes.length !== 32) throw fail("That is not a backup key.", "BACKUP_KEY_INVALID", 422);

  const fingerprint = keyFingerprint(nacl, bytes);

  await HostelBackupModel.updateOne(
    { hostelId },
    {
      $set: { keyFingerprint: fingerprint, keySetAt: new Date(), keySetBy: principal.userId, publicKey },
      $unset: { kitConfirmedAt: 1 },
    },
    { upsert: true },
  );
  await audit(principal.userId, hostelId, "BACKUP_KEY_SET", { fingerprint });

  return { fingerprint };
}

/** The owner says the recovery kit for this exact key is saved. */
export async function confirmRecoveryKit(principal: ApiPrincipal, requestedHostelId: string | undefined, fingerprint: string) {
  const hostelId = await ownerHostel(principal, requestedHostelId);
  const result = await HostelBackupModel.updateOne(
    { hostelId, keyFingerprint: fingerprint },
    { $set: { kitConfirmedAt: new Date() } },
  );

  if (!result.matchedCount) throw fail("That recovery kit is for a different key.", "BACKUP_KEY_MISMATCH", 409);

  await audit(principal.userId, hostelId, "BACKUP_KIT_CONFIRMED", { fingerprint });
}

/* ── Drive connection ───────────────────────────────────────────────────── */

type OAuthState = { e: number; f: "app" | "web"; h: string; u: string };

function stateKey() {
  const secret = process.env.JWT_ACCESS_SECRET;

  if (!secret) throw fail("Sign-in is not configured.", "AUTH_NOT_CONFIGURED", 500);

  return createHash("sha256").update(`drive-oauth-state|${secret}`).digest();
}

export function signDriveState(state: OAuthState) {
  const body = Buffer.from(JSON.stringify(state)).toString("base64url");

  return `${body}.${createHmac("sha256", stateKey()).update(body).digest("base64url")}`;
}

export function readDriveState(value: string, now = Date.now()): OAuthState | null {
  const [body, mac] = value.split(".");

  if (!body || !mac) return null;

  const expected = createHmac("sha256", stateKey()).update(body).digest();
  const given = Buffer.from(mac, "base64url");

  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  const state = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as OAuthState;

  return state.e > now ? state : null;
}

export async function driveConnectUrl(principal: ApiPrincipal, requestedHostelId: string | undefined, from: "app" | "web") {
  const hostelId = await ownerHostel(principal, requestedHostelId);

  await assertPlan(hostelId);

  const state = signDriveState({ e: Date.now() + STATE_TTL_MS, f: from, h: hostelId.toString(), u: principal.userId });

  return { url: driveAuthUrl(state, driveRedirectUri()) };
}

/** Google's redirect back. Identity comes from the signed state; ownership and plan are checked again. */
export async function completeDriveConnect(code: string, stateValue: string) {
  await connectToDatabase();

  const state = readDriveState(stateValue);

  if (!state) throw fail("That Drive link has expired. Start again from Backup.", "DRIVE_STATE_INVALID", 400);

  const hostelId = new Types.ObjectId(state.h);

  await resolveOwnedHostel(state.h, state.u);
  await assertPlan(hostelId);

  const { email, refreshToken } = await exchangeDriveCode(code, driveRedirectUri());

  await HostelBackupModel.updateOne(
    { hostelId },
    {
      $set: {
        "drive.connectedAt": new Date(),
        "drive.email": email,
        "drive.status": "CONNECTED",
        "drive.token": sealValue(refreshToken, { hostelId: state.h, purpose: TOKEN_PURPOSE }),
      },
      $unset: { "drive.error": 1 },
    },
    { upsert: true },
  );
  await audit(state.u, hostelId, "BACKUP_DRIVE_CONNECTED", { email: email ?? null });

  return { from: state.f };
}

async function sealedToken(hostelId: Types.ObjectId) {
  const row = await HostelBackupModel.findOne({ hostelId })
    .select("+drive.token")
    .lean<{ drive?: { token?: SecretEnvelope } } | null>();

  return row?.drive?.token ? openValue(row.drive.token, { hostelId: hostelId.toString(), purpose: TOKEN_PURPOSE }) : null;
}

export async function disconnectDrive(principal: ApiPrincipal, requestedHostelId?: string) {
  const hostelId = await ownerHostel(principal, requestedHostelId);
  const token = await sealedToken(hostelId).catch(() => null);

  if (token) await revokeDriveToken(token);

  await HostelBackupModel.updateOne(
    { hostelId },
    { $set: { "drive.status": "NOT_CONNECTED" }, $unset: { "drive.email": 1, "drive.error": 1, "drive.token": 1 } },
  );
  await audit(principal.userId, hostelId, "BACKUP_DRIVE_DISCONNECTED", {});
}

/** Records what Drive said, so the screen can offer Reconnect or say the Drive is full. */
async function noteDriveError(hostelId: Types.ObjectId, error: DriveError) {
  const status = error.errorCode === "REVOKED" ? "REVOKED" : error.errorCode === "QUOTA_FULL" ? "QUOTA_FULL" : "ERROR";

  await HostelBackupModel.updateOne({ hostelId }, { $set: { "drive.error": error.message, "drive.status": status } });
}

async function accessTokenFor(hostelId: Types.ObjectId) {
  const refresh = await sealedToken(hostelId);

  if (!refresh) throw new DriveError("REVOKED", "Google Drive is not connected.");

  try {
    return await driveAccessToken(refresh);
  } catch (error) {
    if (error instanceof DriveError) await noteDriveError(hostelId, error);
    throw error;
  }
}

/* ── Backing up ─────────────────────────────────────────────────────────── */

export async function runHostelBackup(hostelId: Types.ObjectId, trigger: "SCHEDULE" | "MANUAL", actorId: string | null = null) {
  await connectToDatabase();

  const config = await HostelBackupModel.findOne({ hostelId }).lean<BackupRow | null>();

  if (!config?.publicKey) throw fail("Set up the recovery key first.", "BACKUP_KEY_MISSING", 409);

  await assertPlan(hostelId);
  await HostelBackupModel.updateOne({ hostelId }, { $set: { lastRunAt: new Date() } });

  try {
    const data = await buildTenantExport(hostelId);
    const { bytes, chunks } = packTenantExport(data);
    const file = sealArchive(nacl, bytes, fromBase64(config.publicKey), { createdAt: data.createdAt, hostelId: hostelId.toString() });

    bytes.fill(0); // the plaintext is gone before anything leaves the server

    const fileName = `hostelpalika-backup-${data.createdAt.slice(0, 16).replace(/[:T]/g, "-")}.hpbk`;
    const token = await accessTokenFor(hostelId);
    const uploaded = await uploadToAppData(token, fileName, file);
    const checked =
      uploaded.md5Checksum === createHash("md5").update(file).digest("hex") && Number(uploaded.size) === file.length;
    const run = await HostelBackupRunModel.create({
      bytes: file.length,
      checked,
      chunks,
      counts: data.counts,
      driveFileId: uploaded.id,
      fileName,
      hostelId,
      keyFingerprint: config.keyFingerprint,
      sha512: Buffer.from(nacl.hash(file)).toString("hex"),
      status: "OK",
      trigger,
    });

    await HostelBackupModel.updateOne({ hostelId }, { $set: { "drive.status": "CONNECTED" }, $unset: { "drive.error": 1 } });
    await audit(actorId, hostelId, "BACKUP_MADE", { bytes: file.length, checked, runId: run._id.toString(), trigger });
    await pruneDrive(hostelId, token).catch((error) => logger.warn("backup prune failed", { hostelId: String(hostelId), message: String(error?.message) }));

    return { checked, id: run._id.toString(), ok: true as const };
  } catch (error) {
    const message = error instanceof DriveError ? error.message : "The backup could not be made.";

    if (error instanceof DriveError) await noteDriveError(hostelId, error);
    else logger.error("backup failed", { hostelId: String(hostelId), message: String((error as Error)?.message) });

    await HostelBackupRunModel.create({ error: message, hostelId, keyFingerprint: config.keyFingerprint, status: "FAILED", trigger });

    return { error: message, ok: false as const };
  }
}

/** Keeps the newest `KEEP_ON_DRIVE` files; older history rows stay, marked as no longer on Drive. */
async function pruneDrive(hostelId: Types.ObjectId, token: string) {
  const old = await HostelBackupRunModel.find({ driveFileId: { $exists: true }, hostelId, status: "OK" })
    .sort({ createdAt: -1 })
    .skip(KEEP_ON_DRIVE)
    .select("driveFileId")
    .lean<Array<{ _id: Types.ObjectId; driveFileId: string }>>();

  for (const run of old) {
    await deleteFromAppData(token, run.driveFileId);
    await HostelBackupRunModel.updateOne({ _id: run._id }, { $unset: { driveFileId: 1 } });
  }
}

export async function backUpNow(principal: ApiPrincipal, requestedHostelId?: string) {
  const hostelId = await ownerHostel(principal, requestedHostelId);

  return runHostelBackup(hostelId, "MANUAL", principal.userId);
}

/** Cron: one backup a day per connected hostel, oldest first, inside the function's time. */
export async function runScheduledBackups(now = new Date(), budgetMs = 240_000) {
  await connectToDatabase();

  const started = Date.now();
  // REVOKED waits for the owner to reconnect; retrying cannot fix it.
  const due = await HostelBackupModel.find({
    $or: [{ lastRunAt: null }, { lastRunAt: { $exists: false } }, { lastRunAt: { $lt: new Date(now.getTime() - 20 * 3_600_000) } }],
    "drive.status": { $in: ["CONNECTED", "QUOTA_FULL", "ERROR"] },
    publicKey: { $exists: true, $ne: null },
  })
    .sort({ lastRunAt: 1 })
    .limit(100)
    .select("hostelId")
    .lean<Array<{ hostelId: Types.ObjectId }>>();
  const results: Array<{ hostelId: string; ok: boolean }> = [];

  for (const { hostelId } of due) {
    if (Date.now() - started > budgetMs) break;
    if (!(await backupPlanAllows(hostelId))) continue;

    const result = await runHostelBackup(hostelId, "SCHEDULE");

    results.push({ hostelId: hostelId.toString(), ok: result.ok });
  }

  return { due: due.length, failed: results.filter((result) => !result.ok).length, ran: results.length };
}

/* ── Download and restore ───────────────────────────────────────────────── */

async function ownRun(hostelId: Types.ObjectId, runId: string, select: string) {
  if (!Types.ObjectId.isValid(runId)) throw fail("Backup not found.", "BACKUP_NOT_FOUND", 404);

  // Scoped in the query: another hostel's run is simply not found.
  const run = await HostelBackupRunModel.findOne({ _id: new Types.ObjectId(runId), hostelId, status: "OK" })
    .select(select)
    .lean<RunRow | null>();

  if (!run) throw fail("Backup not found.", "BACKUP_NOT_FOUND", 404);

  return run;
}

/** The encrypted file, streamed from Drive. It is ciphertext: we cannot read it, neither can anyone without the kit. */
export async function downloadBackupFile(principal: ApiPrincipal, requestedHostelId: string | undefined, runId: string) {
  const hostelId = await ownerHostel(principal, requestedHostelId);
  const run = await ownRun(hostelId, runId, "driveFileId fileName bytes sha512");

  if (!run.driveFileId) throw fail("This backup is no longer kept in Drive.", "BACKUP_NOT_ON_DRIVE", 410);

  const response = await downloadFromAppData(await accessTokenFor(hostelId), run.driveFileId);

  return { body: response.body, bytes: run.bytes ?? null, fileName: run.fileName ?? "backup.hpbk", sha512: run.sha512 ?? "" };
}

/**
 * One chunk of a decrypted backup, sent back by the owner's phone.
 *
 * Accepted only when its hash is the one recorded for this hostel's run — so a
 * forged chunk, an edited one, or one from another hostel's archive is refused
 * — and every row's hostel is still this hostel or its branch. Only rows that
 * are missing are added; nothing existing is changed or deleted.
 */
export async function restoreBackupChunk(
  principal: ApiPrincipal,
  requestedHostelId: string | undefined,
  input: { collection: string; data: string; index: number; runId: string },
) {
  const hostelId = await ownerHostel(principal, requestedHostelId);
  const run = await ownRun(hostelId, input.runId, "chunks");
  const recorded = run.chunks?.find((chunk) => chunk.collection === input.collection && chunk.index === input.index);

  if (!recorded || recorded.sha256 !== sha256Hex(Buffer.from(input.data, "utf8"))) {
    throw fail("This part of the backup does not match what was backed up.", "BACKUP_CHUNK_MISMATCH", 422);
  }

  const entry = TENANT_COLLECTIONS.find((candidate) => candidate.name === input.collection);

  if (!entry?.restore) return { added: 0, kept: recorded.rows, refused: 0, restorable: false };

  const rows = parseChunk(input.data);
  const allowed = new Set((await tenantHostelIds(hostelId)).map(String));

  if (rows.some((row) => !allowed.has(String(row[entry.key])))) {
    throw fail("This backup holds rows of a hostel that is not yours.", "BACKUP_OTHER_HOSTEL", 422);
  }

  const existing = new Set(
    (await entry.model.collection.find({ _id: { $in: rows.map((row) => row._id as Types.ObjectId) } }, { projection: { _id: 1 } }).toArray()).map(
      (row) => String(row._id),
    ),
  );
  const missing = rows.filter((row) => !existing.has(String(row._id)));
  let added = 0;

  if (missing.length) {
    try {
      added = (await entry.model.collection.insertMany(missing, { ordered: false })).insertedCount;
    } catch (error) {
      // A unique index refused some rows (a newer row took their place); the rest went in.
      added = (error as { insertedCount?: number }).insertedCount ?? 0;
    }
  }

  await audit(principal.userId, hostelId, "BACKUP_RESTORED", {
    added,
    collection: input.collection,
    index: input.index,
    runId: input.runId,
  });

  return { added, kept: rows.length - missing.length, refused: missing.length - added, restorable: true };
}
