/**
 * Deciding what a picked file *is*, before anything touches it.
 *
 * Its own module, with no imports, for the same reason `lib/status.ts` is:
 * Vitest here runs node-side with no React Native shim, so `lib/uploads.ts`
 * cannot be tested once it imports `expo-file-system`. This is the part of the
 * upload that has real branches, so it lives where the tests can reach it.
 *
 * The stakes: R2 signs the `Content-Type` into the presigned URL. If the type
 * declared at presign is not the type sent on the PUT, the upload fails with a
 * signature error that mentions nothing about content types — so both have to
 * come from one function, and that function must always return something.
 */

const EXTENSION_MIME: Record<string, string> = {
  /**
   * What `expo-audio` writes for a maintenance voice note. AAC in an MPEG-4
   * container, and the platform's own `audio/x-m4a` label is what the server's
   * allowlist and byte sniffer both expect.
   */
  m4a: "audio/x-m4a",
  heic: "image/heic",
  heif: "image/heif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  mov: "video/quicktime",
  mp4: "video/mp4",
  pdf: "application/pdf",
  png: "image/png",
  webm: "video/webm",
  webp: "image/webp",
};

type PickedFile = {
  fileName?: string | null;
  mimeType?: string | null;
  uri: string;
};

/** `expo-image-picker` does not always populate `mimeType`; the uri always exists. */
export function resolveMimeType(asset: PickedFile): string {
  if (asset.mimeType) {
    return asset.mimeType;
  }

  const source = asset.fileName ?? asset.uri;
  // Android `content://` uris and cached picker paths routinely carry a query
  // string, which would otherwise be read as part of the extension.
  const extension = source.split("?")[0].split(".").pop()?.toLowerCase() ?? "";

  return EXTENSION_MIME[extension] ?? "image/jpeg";
}

/**
 * Whether this file is a recording rather than a picture.
 *
 * Used by the screens that draw a play button instead of a thumbnail. Reads the
 * resolved type rather than the extension, so a recorder that labels its own
 * output is believed over a guess from the path.
 */
export function isAudio(asset: PickedFile): boolean {
  return resolveMimeType(asset).startsWith("audio/");
}

/**
 * A name is required by the presign route and becomes part of the storage key,
 * so an unnamed pick gets a unique one rather than a hundred files called
 * "image".
 */
export function resolveFileName(asset: PickedFile): string {
  if (asset.fileName) {
    return asset.fileName;
  }

  const mime = resolveMimeType(asset);
  const extension =
    Object.entries(EXTENSION_MIME).find(([, value]) => value === mime)?.[0] ?? "jpg";


  return `upload-${Date.now()}.${extension}`;
}
