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
export function acceptsSharedPayment(file: SharedPaymentFile) {
  return Boolean(file.uri) && (file.mimeType?.startsWith("image/") || file.mimeType === "application/pdf")
    && (file.fileSize === undefined || file.fileSize > 0 && file.fileSize <= 20 * 1024 * 1024);
}
