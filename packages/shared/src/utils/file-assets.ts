export const DEFAULT_IMAGE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_DOCUMENT_BYTES = 10 * 1024 * 1024;
/**
 * Community posts carry video. Nothing transcodes it, so the cap is the size a
 * phone can upload and a browser can stream back without a pipeline behind it.
 */
export const DEFAULT_VIDEO_BYTES = 50 * 1024 * 1024;
/**
 * A maintenance voice note is a warden holding a phone up to a leaking tap and
 * describing it. Two minutes of mono AAC at 32 kbps is under half a megabyte, so
 * 10 MB is room for a very long one and still far below the point where a
 * provider on a Nepali mobile connection gives up waiting for it to load.
 */
export const DEFAULT_AUDIO_BYTES = 10 * 1024 * 1024;
export const DEFAULT_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];
/** Types every current browser can play from a plain `<video>` element. */
export const DEFAULT_VIDEO_MIME_TYPES = ["video/mp4", "video/webm", "video/quicktime"];
/**
 * What `expo-audio` actually records, and nothing else.
 *
 * `RecordingPresets` writes `.m4a` on both platforms — AAC in an MPEG-4
 * container — which arrives labelled `audio/mp4`, `audio/m4a` or `audio/x-m4a`
 * depending on which end names it. All three are the same container, and
 * `sniff.ts` resolves every one of them to `ISO_MEDIA`, so a declaration that
 * disagrees with the bytes is still refused.
 *
 * **`audio/mpeg` is deliberately absent.** Nothing in the product records MP3,
 * and an MP3 has no reliable magic number to sniff — the frame header is a bit
 * pattern that occurs in arbitrary binary — so accepting it would be the one
 * audio type whose declaration nothing could check.
 */
export const DEFAULT_AUDIO_MIME_TYPES = [
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/aac",
  "audio/webm",
];
export const DEFAULT_DOCUMENT_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/plain",
  /**
   * Provider statements for Tier 0.5 reconciliation. A CSV is `text/plain` with
   * a different label, so this widens nothing the platform did not already
   * accept — but browsers vary on which of the two they report for a `.csv`,
   * and an owner should not have their monthly statement bounced over it.
   */
  "text/csv",
  /** What Android reports for a `.csv` (the app picker passes it through). */
  "text/comma-separated-values",
  /**
   * The formats the wallets actually hand out. eSewa's export is a legacy BIFF8
   * `.xls` and Khalti's is an `.xlsx`, so a CSV-only allowlist meant every owner
   * had to open the file and re-save it before they could reconcile — a step
   * that in practice ends with the reconciling not happening.
   *
   * Only the two specific spreadsheet types. `application/octet-stream` is
   * **deliberately not here**: a browser with no Excel installed reports that
   * (or nothing at all) for a `.xls`, but adding it would let any binary
   * whatsoever through every document upload on the platform — payment proofs
   * and identity documents included — since the stored content type is still
   * only the client's word. The gap is closed at the other end instead, by
   * `mimeTypeForStatement` labelling the file from its extension before
   * presign.
   */
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

/**
 * The MIME type a statement upload should declare, given the file's name.
 *
 * Browsers are unreliable here in a way that matters: a `.xls` picked on a
 * machine without Excel installed is reported as `application/octet-stream` or
 * as the empty string, and a `.csv` is `text/csv` on some platforms and
 * `text/plain` on others. Rejecting those would bounce a perfectly good
 * statement, and widening the allowlist to `application/octet-stream` to
 * accommodate them would open every document upload on the platform to
 * arbitrary binaries.
 *
 * So the extension decides, and only for extensions the reconcile screen asks
 * for. The label is still just a label — nothing downstream trusts it, because
 * `statements/parsers/source.ts` reads the real format out of the file's magic
 * bytes — but it keeps the door policy narrow and honest instead of open.
 */
export function mimeTypeForStatement(
  fileName: string,
  browserType?: string,
): string | null {
  const extension = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];

  switch (extension) {
    case "csv":
      return "text/csv";
    case "xls":
      return "application/vnd.ms-excel";
    case "xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    default:
      // An extension this screen never asked for. Hand back whatever the
      // browser said and let the normal allowlist refuse it.
      return browserType?.trim() ? browserType : null;
  }
}

/**
 * Every MIME type the platform accepts anywhere, deduped. This is the list the
 * browser-side universal uploader pre-validates against; the server remains
 * authoritative via {@link validateFileAssetMetadata}, which additionally honours
 * the `ALLOWED_*_MIME_TYPES` env overrides that a client cannot see.
 */
export const PLATFORM_ACCEPTED_MIME_TYPES = Array.from(
  new Set([
    ...DEFAULT_IMAGE_MIME_TYPES,
    ...DEFAULT_DOCUMENT_MIME_TYPES,
    ...DEFAULT_VIDEO_MIME_TYPES,
    ...DEFAULT_AUDIO_MIME_TYPES,
  ]),
);

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function mimeList(value: string | undefined, fallback: string[]) {
  const parsed =
    value
      ?.split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean) ?? [];

  return parsed.length > 0 ? parsed : fallback;
}

export function fileAssetLimits() {
  return {
    allowedAudioMimeTypes: mimeList(
      process.env.ALLOWED_AUDIO_MIME_TYPES,
      DEFAULT_AUDIO_MIME_TYPES,
    ),
    allowedDocumentMimeTypes: mimeList(
      process.env.ALLOWED_DOCUMENT_MIME_TYPES,
      DEFAULT_DOCUMENT_MIME_TYPES,
    ),
    allowedImageMimeTypes: mimeList(
      process.env.ALLOWED_IMAGE_MIME_TYPES,
      DEFAULT_IMAGE_MIME_TYPES,
    ),
    maxDocumentBytes: positiveInteger(
      process.env.UPLOAD_MAX_DOCUMENT_BYTES,
      DEFAULT_DOCUMENT_BYTES,
    ),
    maxImageBytes: positiveInteger(
      process.env.UPLOAD_MAX_IMAGE_BYTES,
      DEFAULT_IMAGE_BYTES,
    ),
    allowedVideoMimeTypes: mimeList(
      process.env.ALLOWED_VIDEO_MIME_TYPES,
      DEFAULT_VIDEO_MIME_TYPES,
    ),
    maxVideoBytes: positiveInteger(
      process.env.UPLOAD_MAX_VIDEO_BYTES,
      DEFAULT_VIDEO_BYTES,
    ),
    maxAudioBytes: positiveInteger(
      process.env.UPLOAD_MAX_AUDIO_BYTES,
      DEFAULT_AUDIO_BYTES,
    ),
  };
}

export function validateFileAssetMetadata(input: {
  mimeType?: string | null;
  sizeBytes?: number | null;
}) {
  const limits = fileAssetLimits();
  const mimeType = input.mimeType?.toLowerCase().trim();
  const sizeBytes = input.sizeBytes;

  if (!mimeType) {
    return "File MIME type is required.";
  }

  if (!Number.isFinite(sizeBytes) || typeof sizeBytes !== "number" || sizeBytes <= 0) {
    return "File size must be a positive number of bytes.";
  }

  if (limits.allowedImageMimeTypes.includes(mimeType)) {
    return sizeBytes <= limits.maxImageBytes
      ? null
      : `Image exceeds the ${limits.maxImageBytes} byte upload limit.`;
  }

  if (limits.allowedVideoMimeTypes.includes(mimeType)) {
    return sizeBytes <= limits.maxVideoBytes
      ? null
      : `Video exceeds the ${limits.maxVideoBytes} byte upload limit.`;
  }

  if (limits.allowedAudioMimeTypes.includes(mimeType)) {
    return sizeBytes <= limits.maxAudioBytes
      ? null
      : `Audio exceeds the ${limits.maxAudioBytes} byte upload limit.`;
  }

  if (limits.allowedDocumentMimeTypes.includes(mimeType)) {
    return sizeBytes <= limits.maxDocumentBytes
      ? null
      : `Document exceeds the ${limits.maxDocumentBytes} byte upload limit.`;
  }

  return "File MIME type is not allowed.";
}
