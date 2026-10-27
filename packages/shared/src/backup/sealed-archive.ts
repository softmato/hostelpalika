/**
 * The customer backup file (docs/FIELD_REVIEW_2026_10_27.md I4, threat model in
 * docs/BACKUP.md).
 *
 * The owner's phone holds an X25519 key pair; the server only ever sees the
 * public half. Each backup gets a fresh random 32-byte data key; the archive is
 * encrypted with it (XSalsa20-Poly1305, NaCl `secretbox`) and the data key is
 * sealed to the owner's public key with a throwaway sender key (NaCl `box`,
 * the libsodium sealed-box construction). The server forgets the data key the
 * moment the file is written, so it cannot read a backup it made.
 *
 * Layout: `HPBK` · version byte · u32 header length · header JSON · secretbox.
 *
 * The header's hostel id and time are sealed inside the key box too, so a
 * header edited to claim another hostel no longer opens. Integrity of the file
 * as a whole is the server's recorded SHA-256 (any key holder can make a valid
 * file — see the threat model).
 *
 * NaCl is passed in rather than imported: the web and the app each bring their
 * own copy of `tweetnacl`, and this file stays free of a dependency both
 * bundlers would have to agree on.
 */

export type NaclLike = {
  box: ((message: Uint8Array, nonce: Uint8Array, publicKey: Uint8Array, secretKey: Uint8Array) => Uint8Array) & {
    keyPair: (() => { publicKey: Uint8Array; secretKey: Uint8Array }) & {
      fromSecretKey: (secretKey: Uint8Array) => { publicKey: Uint8Array; secretKey: Uint8Array };
    };
    open: (box: Uint8Array, nonce: Uint8Array, publicKey: Uint8Array, secretKey: Uint8Array) => Uint8Array | null;
  };
  hash: (message: Uint8Array) => Uint8Array;
  randomBytes: (length: number) => Uint8Array;
  secretbox: ((message: Uint8Array, nonce: Uint8Array, key: Uint8Array) => Uint8Array) & {
    open: (box: Uint8Array, nonce: Uint8Array, key: Uint8Array) => Uint8Array | null;
  };
};

export const ARCHIVE_VERSION = 1;
const MAGIC = [0x48, 0x50, 0x42, 0x4b]; // "HPBK"
const KEY_BYTES = 32;
const NONCE_BYTES = 24;

export type ArchiveHeader = {
  createdAt: string;
  /** Sender's throwaway public key. */
  epk: string;
  hostelId: string;
  /** Nonce of the data. */
  nonce: string;
  /** Fingerprint of the key it is sealed to. */
  recipient: string;
  v: number;
  /** Nonce of the sealed data key. */
  wrapNonce: string;
  /** Data key + hostel id + time, sealed to the recipient. */
  wrappedKey: string;
};

export class ArchiveError extends Error {
  constructor(public code: "NOT_AN_ARCHIVE" | "WRONG_KEY" | "DAMAGED", message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

/* ── bytes ──────────────────────────────────────────────────────────────── */

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function toBase64(bytes: Uint8Array) {
  let out = "";

  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);

    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63]! : "=";
    out += i + 2 < bytes.length ? B64[n & 63]! : "=";
  }

  return out;
}

export function fromBase64(text: string) {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let index = 0;

  for (const char of clean) {
    value = (value << 6) | B64.indexOf(char);
    bits += 6;

    if (bits >= 8) {
      bits -= 8;
      out[index++] = (value >> bits) & 0xff;
    }
  }

  return out.subarray(0, index);
}

export function utf8Encode(text: string) {
  return new TextEncoder().encode(text);
}

/** Hermes has `TextEncoder` but not always `TextDecoder`, so decode by hand. */
export function utf8Decode(bytes: Uint8Array) {
  let out = "";

  for (let i = 0; i < bytes.length; ) {
    const byte = bytes[i++]!;
    let code = byte;

    if (byte >= 0xf0) code = ((byte & 7) << 18) | ((bytes[i++]! & 63) << 12) | ((bytes[i++]! & 63) << 6) | (bytes[i++]! & 63);
    else if (byte >= 0xe0) code = ((byte & 15) << 12) | ((bytes[i++]! & 63) << 6) | (bytes[i++]! & 63);
    else if (byte >= 0xc0) code = ((byte & 31) << 6) | (bytes[i++]! & 63);

    out += String.fromCodePoint(code);
  }

  return out;
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;

  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
};

const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);

/* ── keys ───────────────────────────────────────────────────────────────── */

/** `3F2A-91C0-…`: the first 8 bytes of SHA-512 of a public key. Shown on both ends to compare. */
export function keyFingerprint(nacl: NaclLike, publicKey: Uint8Array) {
  const hex = Array.from(nacl.hash(publicKey).subarray(0, 8), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();

  return hex.match(/.{4}/g)!.join("-");
}

// Crockford base32: no I, L, O, U — nothing that reads as another character.
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * The recovery code: the 32-byte private key as 52 base32 characters plus 4
 * of checksum, in 14 groups of 4. Typed back in, a single wrong character is
 * caught by the checksum instead of producing a key that opens nothing.
 */
export function recoveryCodeFromKey(nacl: NaclLike, secretKey: Uint8Array) {
  const sum = nacl.hash(secretKey).subarray(0, 3);
  let bits = 0;
  let value = 0;
  let out = "";

  for (const byte of concat(secretKey, sum)) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5 && out.length < 56) {
      bits -= 5;
      out += B32[(value >> bits) & 31];
    }

    value &= (1 << bits) - 1;
  }

  return out.match(/.{4}/g)!.join(" ");
}

/** The private key back from a recovery code, or null when it is mistyped. */
export function keyFromRecoveryCode(nacl: NaclLike, code: string) {
  const clean = code
    .toUpperCase()
    .replace(/^HPKEY1:/, "")
    .replace(/[OI L]/g, (char) => (char === "O" ? "0" : char === " " ? "" : "1"))
    .replace(/[^0-9A-Z]/g, "");

  if (clean.length !== 56) return null;

  const bytes = new Uint8Array(35);
  let bits = 0;
  let value = 0;
  let index = 0;

  for (const char of clean) {
    const digit = B32.indexOf(char);

    if (digit < 0) return null;

    value = (value << 5) | digit;
    bits += 5;

    if (bits >= 8) {
      bits -= 8;
      bytes[index++] = (value >> bits) & 0xff;
      value &= (1 << bits) - 1;
    }
  }

  const secretKey = bytes.slice(0, KEY_BYTES);

  return recoveryCodeFromKey(nacl, secretKey).replace(/ /g, "") === clean ? secretKey : null;
}

/** What the recovery kit's QR holds. */
export const recoveryQrText = (code: string) => `HPKEY1:${code.replace(/ /g, "")}`;

/* ── archive ────────────────────────────────────────────────────────────── */

const bindingOf = (hostelId: string, createdAt: string) => utf8Encode(`${hostelId}|${createdAt}`);

export function sealArchive(
  nacl: NaclLike,
  plaintext: Uint8Array,
  recipientPublicKey: Uint8Array,
  meta: { createdAt: string; hostelId: string },
) {
  if (recipientPublicKey.length !== KEY_BYTES) throw new ArchiveError("WRONG_KEY", "That is not a backup key.");

  const dataKey = nacl.randomBytes(KEY_BYTES);
  const nonce = nacl.randomBytes(NONCE_BYTES);
  const wrapNonce = nacl.randomBytes(NONCE_BYTES);
  const sender = nacl.box.keyPair();
  const wrappedKey = nacl.box(concat(dataKey, bindingOf(meta.hostelId, meta.createdAt)), wrapNonce, recipientPublicKey, sender.secretKey);
  const header: ArchiveHeader = {
    createdAt: meta.createdAt,
    epk: toBase64(sender.publicKey),
    hostelId: meta.hostelId,
    nonce: toBase64(nonce),
    recipient: keyFingerprint(nacl, recipientPublicKey),
    v: ARCHIVE_VERSION,
    wrapNonce: toBase64(wrapNonce),
    wrappedKey: toBase64(wrappedKey),
  };
  const headerBytes = utf8Encode(JSON.stringify(header));
  const length = new Uint8Array(4);

  new DataView(length.buffer).setUint32(0, headerBytes.length);
  sender.secretKey.fill(0);

  const body = nacl.secretbox(plaintext, nonce, dataKey);

  dataKey.fill(0);

  return concat(Uint8Array.from(MAGIC), Uint8Array.of(ARCHIVE_VERSION), length, headerBytes, body);
}

/** The header, readable without any key — enough to refuse the wrong hostel before decrypting. */
export function readArchiveHeader(bytes: Uint8Array) {
  if (bytes.length < 9 || !MAGIC.every((byte, i) => bytes[i] === byte) || bytes[4] !== ARCHIVE_VERSION) {
    throw new ArchiveError("NOT_AN_ARCHIVE", "This is not a HostelPalika backup file.");
  }

  const length = new DataView(bytes.buffer, bytes.byteOffset + 5, 4).getUint32(0);

  if (9 + length > bytes.length) throw new ArchiveError("DAMAGED", "This backup file is cut short.");

  try {
    const header = JSON.parse(utf8Decode(bytes.subarray(9, 9 + length))) as ArchiveHeader;

    return { body: bytes.subarray(9 + length), header };
  } catch {
    throw new ArchiveError("DAMAGED", "This backup file is damaged.");
  }
}

export function openArchive(nacl: NaclLike, bytes: Uint8Array, secretKey: Uint8Array) {
  const { body, header } = readArchiveHeader(bytes);
  const own = nacl.box.keyPair.fromSecretKey(secretKey).publicKey;

  if (keyFingerprint(nacl, own) !== header.recipient) {
    throw new ArchiveError("WRONG_KEY", "This backup was made for a different recovery key.");
  }

  const unwrapped = nacl.box.open(fromBase64(header.wrappedKey), fromBase64(header.wrapNonce), fromBase64(header.epk), secretKey);

  if (!unwrapped || !equal(unwrapped.subarray(KEY_BYTES), bindingOf(header.hostelId, header.createdAt))) {
    throw new ArchiveError("DAMAGED", "This backup file has been changed and cannot be trusted.");
  }

  const plaintext = nacl.secretbox.open(body, fromBase64(header.nonce), unwrapped.subarray(0, KEY_BYTES));

  unwrapped.fill(0);

  if (!plaintext) throw new ArchiveError("DAMAGED", "This backup file has been changed and cannot be trusted.");

  return { header, plaintext };
}
