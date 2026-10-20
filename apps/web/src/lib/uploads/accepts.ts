import {
  DEFAULT_DOCUMENT_BYTES,
  DEFAULT_DOCUMENT_MIME_TYPES,
  DEFAULT_IMAGE_BYTES,
  DEFAULT_IMAGE_MIME_TYPES,
  DEFAULT_VIDEO_BYTES,
  DEFAULT_VIDEO_MIME_TYPES,
  PLATFORM_ACCEPTED_MIME_TYPES,
} from "@hostel/shared/utils/file-assets";

/**
 * Browser-side mirror of the server's file rules.
 *
 * The server is always the authority (`validateFileAssetMetadata` on every
 * upload route) — this exists so the uploader can reject an obviously bad file
 * before spending the user's bandwidth, and so `<input accept>` advertises the
 * right types in the OS file picker. Env overrides (`ALLOWED_*_MIME_TYPES`,
 * `UPLOAD_MAX_*_BYTES`) are server-only, so a file that passes here can still be
 * rejected server-side; that path surfaces as a normal upload error.
 */
export type UploadKind = "any" | "document" | "image" | "media" | "video";

type KindRule = {
  /** Human label used in error copy, e.g. "Image must be JPG, PNG or WebP." */
  label: string;
  maxBytes: number;
  mimeTypes: string[];
};

const KIND_RULES: Record<UploadKind, KindRule> = {
  any: {
    label: "File",
    // The widest limit any accepted type allows; per-type limits still apply below.
    maxBytes: Math.max(DEFAULT_DOCUMENT_BYTES, DEFAULT_IMAGE_BYTES, DEFAULT_VIDEO_BYTES),
    mimeTypes: PLATFORM_ACCEPTED_MIME_TYPES,
  },
  document: {
    label: "Document",
    maxBytes: DEFAULT_DOCUMENT_BYTES,
    mimeTypes: DEFAULT_DOCUMENT_MIME_TYPES,
  },
  image: {
    label: "Image",
    maxBytes: DEFAULT_IMAGE_BYTES,
    mimeTypes: DEFAULT_IMAGE_MIME_TYPES,
  },
  /** Photos and clips together — what a community post attaches. */
  media: {
    label: "Photo or video",
    maxBytes: Math.max(DEFAULT_IMAGE_BYTES, DEFAULT_VIDEO_BYTES),
    mimeTypes: [...DEFAULT_IMAGE_MIME_TYPES, ...DEFAULT_VIDEO_MIME_TYPES],
  },
  video: {
    label: "Video",
    maxBytes: DEFAULT_VIDEO_BYTES,
    mimeTypes: DEFAULT_VIDEO_MIME_TYPES,
  },
};

const EXTENSION_BY_MIME: Record<string, string> = {
  "application/pdf": "PDF",
  "image/jpeg": "JPG",
  "image/png": "PNG",
  "image/webp": "WebP",
  "text/plain": "TXT",
  "video/mp4": "MP4",
  "video/quicktime": "MOV",
  "video/webm": "WebM",
};

export function uploadKindRule(kind: UploadKind = "any") {
  return KIND_RULES[kind];
}

/** Value for an `<input type="file" accept="...">` attribute. */
export function acceptAttribute(kind: UploadKind = "any", override?: string) {
  return override ?? uploadKindRule(kind).mimeTypes.join(",");
}

function joinTypes(labels: string[]) {
  if (labels.length <= 1) {
    return labels[0] ?? "Any file";
  }

  return `${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}`;
}

function labelsFor(mimeTypes: string[]) {
  return mimeTypes
    .map((mime) => EXTENSION_BY_MIME[mime.trim().toLowerCase()])
    .filter(
      (value, index, all): value is string =>
        Boolean(value) && all.indexOf(value) === index,
    );
}

/**
 * Which server cap a MIME type answers to. A field that accepts several
 * families (a community post takes photos *and* clips) must quote each one
 * separately — a single number would be wrong for half the list.
 */
type MimeFamily = "image" | "other" | "video";

const FAMILY_ORDER: MimeFamily[] = ["image", "video", "other"];

const FAMILY_BYTES: Record<MimeFamily, number> = {
  image: DEFAULT_IMAGE_BYTES,
  other: DEFAULT_DOCUMENT_BYTES,
  video: DEFAULT_VIDEO_BYTES,
};

function familyOf(mimeType: string): MimeFamily {
  if (DEFAULT_IMAGE_MIME_TYPES.includes(mimeType)) {
    return "image";
  }

  return DEFAULT_VIDEO_MIME_TYPES.includes(mimeType) ? "video" : "other";
}

/** The effective cap for one file: never looser than its own family allows. */
function maxBytesFor(mimeType: string, kind: UploadKind) {
  return Math.min(uploadKindRule(kind).maxBytes, FAMILY_BYTES[familyOf(mimeType)]);
}

/**
 * The exact types a field takes. A picker-style `image/*` or `video/*` means
 * "whatever the server takes in that family" — never every subtype, or a HEIC
 * would pass here and fail at the server.
 */
function acceptedTypes(kind: UploadKind, override?: string) {
  if (!override) {
    return uploadKindRule(kind).mimeTypes;
  }

  return override.split(",").flatMap((item) => {
    const mime = item.trim().toLowerCase();

    if (mime === "image/*") return DEFAULT_IMAGE_MIME_TYPES;
    if (mime === "video/*") return DEFAULT_VIDEO_MIME_TYPES;

    return mime ? [mime] : [];
  });
}

/** "JPG, PNG or WebP up to 5 MB" — the hint shown under a drop zone. */
export function uploadHint(kind: UploadKind = "any", override?: string) {
  const mimeTypes = acceptedTypes(kind, override);

  const parts = FAMILY_ORDER.map((family) => {
    const inFamily = mimeTypes.filter((mime) => familyOf(mime) === family);
    const labels = labelsFor(inFamily);

    if (labels.length === 0) {
      return null;
    }

    return `${joinTypes(labels)} up to ${formatBytes(maxBytesFor(inFamily[0], kind))}`;
  }).filter((part): part is string => Boolean(part));

  return parts.length > 0 ? parts.join(" · ") : "Any file";
}

export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** exponent;
  // One decimal for small values, but never a bare ".0" — "5 MB", not "5.0 MB".
  const rounded =
    value >= 10 || exponent === 0 ? Math.round(value) : Number(value.toFixed(1));

  return `${rounded} ${units[exponent]}`;
}

/**
 * Returns an error message when the file is not acceptable, `null` when it is.
 * `accept` mirrors the `<input accept>` value so a call site that narrows the
 * picker (e.g. images only) gets the same narrowing enforced here.
 */
export function validateFileForUpload(
  file: File,
  options: { accept?: string; kind?: UploadKind } = {},
) {
  const mimeType = file.type.toLowerCase().trim();
  const allowed = acceptedTypes(options.kind ?? "any", options.accept);

  if (!mimeType) {
    return `${file.name} has an unrecognised file type.`;
  }

  if (!allowed.includes(mimeType)) {
    return `${file.name} is not an accepted file type. Allowed: ${uploadHint(
      options.kind ?? "any",
      options.accept,
    )}.`;
  }

  // Each family carries its own server limit even inside a wider picker.
  const maxBytes = maxBytesFor(mimeType, options.kind ?? "any");

  if (file.size <= 0) {
    return `${file.name} is empty.`;
  }

  if (file.size > maxBytes) {
    return `${file.name} is ${formatBytes(file.size)} — the limit is ${formatBytes(maxBytes)}.`;
  }

  return null;
}
