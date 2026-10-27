import { Directory, File, Paths } from "expo-file-system";
import * as SecureStore from "expo-secure-store";
import { toQR } from "toqr";
import nacl from "tweetnacl";

import { APP_NAME } from "@/constants/branding";
import { api, API_BASE_URL } from "@/lib/api";
import { getRequestHostelId } from "@/lib/active-hostel";
import { type ApiEnvelope, unwrap } from "@/lib/api-contract";
import { readTokens } from "@/lib/session";
import {
  fromBase64,
  keyFingerprint,
  keyFromRecoveryCode,
  openArchive,
  readArchiveHeader,
  recoveryCodeFromKey,
  recoveryQrText,
  toBase64,
  utf8Decode,
} from "@hostel/backup/sealed-archive";

/**
 * Customer backup on the phone (docs/FIELD_REVIEW_2026_10_27.md I4–I7,
 * docs/BACKUP.md). The private key is made here, kept in SecureStore and the
 * printed kit, and never sent anywhere; restore decrypts here.
 */

/* ── API ────────────────────────────────────────────────────────────────── */

export type BackupRun = {
  bytes: number | null;
  checked: boolean;
  counts: Record<string, number>;
  createdAt: string;
  error: string | null;
  fileName: string | null;
  id: string;
  keyFingerprint: string | null;
  onDrive: boolean;
  sha512: string | null;
  status: "OK" | "FAILED";
  trigger: string;
};

/** `GET /hostel-admin/backup` — `getBackupOverview` on the server. Owner only. */
export type BackupOverview = {
  allowed: boolean;
  drive: {
    connectedAt: string | null;
    email: string | null;
    error: string | null;
    ready: boolean;
    status: "NOT_CONNECTED" | "CONNECTED" | "REVOKED" | "QUOTA_FULL" | "ERROR";
  };
  hostelId: string;
  key: { fingerprint: string | null; kitConfirmedAt: string | null; setAt: string | null } | null;
  runs: BackupRun[];
};

export async function getBackup() {
  return unwrap(await api.get<ApiEnvelope<BackupOverview>>("/hostel-admin/backup"));
}

export async function backUpNow() {
  return unwrap(
    await api.post<ApiEnvelope<{ checked?: boolean; error?: string; ok: boolean }>>("/hostel-admin/backup", {}, { timeout: 300_000 }),
  );
}

export async function driveConnectUrl() {
  return unwrap(await api.post<ApiEnvelope<{ url: string }>>("/hostel-admin/backup/drive", { from: "app" })).url;
}

export async function disconnectDrive() {
  await api.delete("/hostel-admin/backup/drive");
}

export async function confirmKit(fingerprint: string) {
  await api.post("/hostel-admin/backup/key", { fingerprint });
}

export const backupFileUrl = (runId: string) =>
  `${API_BASE_URL}/api/v1/hostel-admin/backup/runs/${runId}/file?hostelId=${getRequestHostelId() ?? ""}`;

/* ── Key ────────────────────────────────────────────────────────────────── */

const keyName = (hostelId: string) => `backup-key-${hostelId}`;

type RandomSource = { getRandomValues: <T extends ArrayBufferView>(array: T) => T };

/**
 * A secure random source. Hermes has none of its own, so it comes from the
 * native `expo-crypto` — which an app built before it was added does not have.
 * Restoring needs no randomness, so only making a key waits on the new build.
 */
function randomSource(): RandomSource | null {
  const global = (globalThis as { crypto?: RandomSource }).crypto;

  if (global?.getRandomValues) return global;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("expo-crypto") as RandomSource;
  } catch {
    return null;
  }
}

export const canMakeKey = () => randomSource() !== null;

let prngSet = false;

function ensurePrng() {
  if (prngSet) return;

  const source = randomSource();

  if (!source) throw new Error("Update the app to set up a recovery key.");

  nacl.setPRNG((target, length) => {
    const bytes = source.getRandomValues(new Uint8Array(length));

    target.set(bytes);
    bytes.fill(0);
  });
  prngSet = true;
}

/** Makes the key pair; returns the kit. Nothing is stored or sent until `saveKey`. */
export function makeKey() {
  ensurePrng();

  const pair = nacl.box.keyPair();

  return {
    code: recoveryCodeFromKey(nacl, pair.secretKey),
    fingerprint: keyFingerprint(nacl, pair.publicKey),
    publicKey: toBase64(pair.publicKey),
    secretKey: pair.secretKey,
  };
}

/** Keeps the private key on this phone and sends the public half to the server. */
export async function saveKey(hostelId: string, key: ReturnType<typeof makeKey>) {
  await SecureStore.setItemAsync(keyName(hostelId), toBase64(key.secretKey), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  await api.put("/hostel-admin/backup/key", { publicKey: key.publicKey });
}

/** The private key on this phone, if it is the one the server holds. */
export async function keyOnPhone(hostelId: string, fingerprint: string | null) {
  const stored = await SecureStore.getItemAsync(keyName(hostelId)).catch(() => null);

  if (!stored || !fingerprint) return null;

  const secretKey = fromBase64(stored);

  return keyFingerprint(nacl, nacl.box.keyPair.fromSecretKey(secretKey).publicKey) === fingerprint ? secretKey : null;
}

/** The QR as one SVG path, black on white — it is going on paper, not the screen. */
function qrSvg(text: string, size: number) {
  const modules = toQR(text);
  const width = Math.sqrt(modules.length);
  let path = "";

  modules.forEach((on, index) => {
    if (on) path += `M${index % width} ${Math.floor(index / width)}h1v1h-1z`;
  });

  return `<svg width="${size}" height="${size}" viewBox="-4 -4 ${width + 8} ${width + 8}" xmlns="http://www.w3.org/2000/svg"><rect x="-4" y="-4" width="${width + 8}" height="${width + 8}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

/**
 * Opens the system print dialog with the kit (print, or "Save as PDF" where the
 * owner chooses). Rendered on this phone; nothing is written by us. `expo-print`
 * is native, so a build without it says so instead of crashing the screen.
 */
export async function printKit(kit: { code: string; fingerprint: string }) {
  let print: typeof import("expo-print");

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    print = require("expo-print") as typeof import("expo-print");
  } catch {
    throw new Error("Update the app to print the kit. Write the code down for now.");
  }

  const cells = kit.code
    .split(" ")
    .map((group, index) => `<div class="cell"><small>${index + 1}</small><b>${group}</b></div>`)
    .join("");

  await print.printAsync({
    html: `<!doctype html><html><head><meta charset="utf-8"><style>
body{font-family:sans-serif;color:#000;margin:32px}
h1{font-size:20px;margin:0 0 4px}
p{margin:2px 0;font-size:13px}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:20px 0}
.cell{border:1px solid #000;border-radius:6px;padding:6px;text-align:center}
.cell small{display:block;font-size:10px}
.cell b{font-family:monospace;font-size:18px;letter-spacing:2px}
.qr{text-align:center}
</style></head><body>
<h1>${APP_NAME} recovery kit</h1>
<p>Key ${kit.fingerprint}</p>
<p>Opens every backup made with this key. Keep it like a house key.</p>
<div class="grid">${cells}</div>
<div class="qr">${qrSvg(recoveryQrText(kit.code), 240)}</div>
</body></html>`,
  });
}

/** A typed or scanned recovery code → the private key, or null when mistyped. */
export function keyFromKit(code: string) {
  return keyFromRecoveryCode(nacl, code);
}

export const fingerprintOf = (secretKey: Uint8Array) => keyFingerprint(nacl, nacl.box.keyPair.fromSecretKey(secretKey).publicKey);

/* ── Restore ────────────────────────────────────────────────────────────── */

export type OpenedBackup = {
  chunks: { collection: string; data: string; index: number }[];
  counts: Record<string, number>;
  createdAt: string;
  hostelId: string;
};

/** Downloads the encrypted file into the app's cache (never to shared storage). */
export async function downloadBackup(run: BackupRun) {
  const tokens = await readTokens();
  const folder = new Directory(Paths.cache, "backup");

  if (!folder.exists) folder.create({ intermediates: true });

  const target = new File(folder, `${run.id}.hpbk`);

  if (target.exists) target.delete();

  return File.downloadFileAsync(backupFileUrl(run.id), target, {
    headers: { Authorization: `Bearer ${tokens?.accessToken ?? ""}` },
    idempotent: true,
  });
}

/**
 * Checks and opens a downloaded backup: our recorded SHA-512, then this
 * hostel, then the key — the file is deleted from the cache either way.
 */
export async function openBackup(file: File, run: BackupRun, hostelId: string, secretKey: Uint8Array): Promise<OpenedBackup> {
  try {
    const bytes = await file.bytes();
    const hash = Array.from(nacl.hash(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

    if (!run.sha512 || hash !== run.sha512) throw new Error("This file is not the backup we made. It was changed or cut short.");

    if (readArchiveHeader(bytes).header.hostelId !== hostelId) {
      throw new Error("This backup belongs to another hostel.");
    }

    const { plaintext } = openArchive(nacl, bytes, secretKey);
    const archive = JSON.parse(utf8Decode(plaintext)) as OpenedBackup;

    plaintext.fill(0);

    if (archive.hostelId !== hostelId) throw new Error("This backup belongs to another hostel.");

    return archive;
  } finally {
    if (file.exists) file.delete();
  }
}

export type RestoreResult = { added: number; kept: number; refused: number; restorable: boolean };

export async function restoreChunk(runId: string, chunk: OpenedBackup["chunks"][number]) {
  return unwrap(
    await api.post<ApiEnvelope<RestoreResult>>("/hostel-admin/backup/restore", { ...chunk, runId }, { timeout: 120_000 }),
  );
}
