export type SharedPaymentFile = {
  uri: string;
  fileName?: string | null;
  mimeType?: string;
  fileSize?: number;
};
let pending: SharedPaymentFile | null = null;
export function setSharedPayment(file: SharedPaymentFile) { pending = file; }
export async function takeSharedPayment() {
  const file = pending;
  pending = null;
  return file;
}
const EXTENSIONS: Record<string, string> = {
  pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  webp: "image/webp", heic: "image/heic", heif: "image/heif",
};
// Providers may report application/octet-stream, */*, or a null/zero size.
// Use the name only for generic MIME types; never reinterpret a known executable.
export function normalizeSharedPayment(file: SharedPaymentFile): SharedPaymentFile {
  const type = file.mimeType?.split(";")[0].trim().toLowerCase();
  const ext = (file.fileName || file.uri).split(/[?#]/)[0].split(".").pop()?.toLowerCase() ?? "";
  return { ...file, mimeType: !type || ["application/octet-stream", "binary/octet-stream", "*/*", "application/x-pdf"].includes(type)
    ? type === "application/x-pdf" ? "application/pdf" : EXTENSIONS[ext] : type };
}
export function acceptsSharedPayment(input: SharedPaymentFile) {
  const file = normalizeSharedPayment(input);
  return Boolean(file.uri) && Boolean(file.mimeType?.startsWith("image/") || file.mimeType === "application/pdf")
    && (file.fileSize === undefined || Number.isFinite(file.fileSize) && file.fileSize > 0 && file.fileSize <= 20 * 1024 * 1024);
}
