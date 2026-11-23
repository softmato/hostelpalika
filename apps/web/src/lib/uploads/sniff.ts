/**
 * What the bytes actually are (target §13.3, gap fix 1).
 *
 * `verifyUploadedObject` used to compare storage's `ContentType` against the
 * type declared at presign — but on a presigned PUT *both* of those come from
 * the client. Storage records whatever `Content-Type` header the uploader sent,
 * so the check compared the client's claim against the same client's claim and
 * agreed every time. Anything at all could be stored as `image/png`.
 *
 * This reads the leading bytes instead. A file's format is in its magic number,
 * which the uploader does not get to choose, so a declaration that disagrees
 * with the bytes is refused rather than recorded.
 *
 * **Families, not exact types.** The question is never "is this precisely
 * `image/jpeg`" — it is "is this declaration a lie". A `.mov` and an `.mp4` are
 * both ISO base media files and browsers disagree about which label to attach,
 * so refusing one because the other was declared would bounce good uploads to no
 * benefit. Types that share a container share a family and satisfy each other.
 *
 * Pure module: no I/O, no clock, no database.
 */

/** How far in we look for a container marker. Every signature here is far shorter. */
const SNIFF_WINDOW = 64;

type Family =
  | "IMAGE_JPEG"
  | "IMAGE_PNG"
  | "IMAGE_WEBP"
  | "PDF"
  | "OLE"
  | "ZIP"
  | "ISO_MEDIA"
  | "MATROSKA"
  | "TEXT";

/**
 * The families each declared type is allowed to be.
 *
 * `text/plain` and `text/csv` map to `TEXT`, which is not a signature but the
 * absence of binary content — see {@link looksTextual}. A CSV has no magic
 * number and never will, so the honest check is "does this contain bytes text
 * cannot", not "does it start with something".
 *
 * `application/vnd.ms-excel` accepts `ZIP` as well as `OLE`: a `.xlsx` renamed
 * to `.xls` is what wallets hand out often enough that refusing it would send
 * owners back to re-saving statements by hand, and `statements/parsers/source.ts`
 * reads the real format from the magic bytes anyway.
 *
 * The four `audio/*` labels are one container between them. An `.m4a` from
 * `expo-audio` is AAC inside MPEG-4 — the same `ftyp` box an `.mp4` has — and
 * which of `audio/mp4`, `audio/m4a`, `audio/x-m4a` or `audio/aac` it arrives
 * labelled as depends on the platform doing the labelling, not on the bytes.
 * Same reasoning as `.mov` and `.mp4` above.
 */
const ALLOWED_FAMILIES: Record<string, Family[]> = {
  "application/pdf": ["PDF"],
  "audio/aac": ["ISO_MEDIA"],
  "audio/m4a": ["ISO_MEDIA"],
  "audio/mp4": ["ISO_MEDIA"],
  "audio/webm": ["MATROSKA"],
  "audio/x-m4a": ["ISO_MEDIA"],
  "application/vnd.ms-excel": ["OLE", "ZIP"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ["ZIP"],
  "image/jpeg": ["IMAGE_JPEG"],
  "image/png": ["IMAGE_PNG"],
  "image/webp": ["IMAGE_WEBP"],
  "text/comma-separated-values": ["TEXT"],
  "text/csv": ["TEXT"],
  "text/plain": ["TEXT"],
  "video/mp4": ["ISO_MEDIA"],
  "video/quicktime": ["ISO_MEDIA"],
  "video/webm": ["MATROSKA"],
};

function startsWith(bytes: Buffer, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;

  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function ascii(bytes: Buffer, offset: number, length: number): string {
  return bytes.subarray(offset, offset + length).toString("latin1");
}

/**
 * The container family of these bytes, or null when nothing is recognised.
 *
 * Null is not "invalid" — it is "no signature we know", which for a text file is
 * the normal case. Only the caller can decide what that means for a given
 * declaration.
 */
export function sniffFamily(input: Buffer | Uint8Array): Family | null {
  const bytes = Buffer.from(
    input.subarray(0, Math.min(input.length, SNIFF_WINDOW)),
  );

  if (bytes.length < 4) return null;

  // JPEG: SOI plus the first marker byte. Two bytes alone (FF D8) collide with
  // too much to be worth trusting on its own.
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "IMAGE_JPEG";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "IMAGE_PNG";
  }
  // RIFF container with a WEBP form type. The RIFF header alone is also WAV and
  // AVI, so the form type at offset 8 is the part that matters.
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return "IMAGE_WEBP";
  }
  if (ascii(bytes, 0, 5) === "%PDF-") return "PDF";
  // Legacy Office compound file — a real `.xls`, and also `.doc`/`.ppt`.
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return "OLE";
  }
  // Zip local file header, which is what an `.xlsx` is.
  if (startsWith(bytes, [0x50, 0x4b]) && bytes[2] !== undefined) return "ZIP";
  // ISO base media (`ftyp` box) covers MP4 and QuickTime alike.
  if (ascii(bytes, 4, 4) === "ftyp") return "ISO_MEDIA";
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "MATROSKA";

  return null;
}

/**
 * Could these bytes be a text file?
 *
 * A NUL byte is the discriminator: no encoding this platform accepts for a CSV
 * or a note produces one, and every binary format that reaches this point
 * without a recognised signature is full of them. Deliberately permissive about
 * everything else — refusing an unusual encoding would bounce a real statement.
 */
export function looksTextual(input: Buffer | Uint8Array): boolean {
  const bytes = Buffer.from(input.subarray(0, Math.min(input.length, 8192)));

  return !bytes.includes(0);
}

/**
 * Why these bytes contradict the type they were declared as, or null when they
 * do not.
 *
 * Unknown declared types pass: the allowlist in `@hostel/shared` is the gate for
 * *which* types may be uploaded, and duplicating it here would mean adding a
 * type in one place and having uploads fail in another.
 */
export function contentTypeMismatch(
  declaredMimeType: string,
  bytes: Buffer | Uint8Array,
): string | null {
  const allowed = ALLOWED_FAMILIES[declaredMimeType.toLowerCase()];

  if (!allowed) return null;

  if (allowed.includes("TEXT")) {
    return looksTextual(bytes)
      ? null
      : "The uploaded file is not text, though it was sent as a text file.";
  }

  const family = sniffFamily(bytes);

  if (!family) {
    return "The uploaded file is not a recognised image, PDF or document. Please upload the original file rather than a renamed copy.";
  }

  if (!allowed.includes(family)) {
    return "The uploaded file's contents do not match its file type. Please upload the original file rather than a renamed copy.";
  }

  return null;
}
