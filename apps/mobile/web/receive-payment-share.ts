import { acceptsSharedPayment, type SharedPaymentFile } from "../src/lib/shared-payment";
export async function receivePaymentShare(id?: string): Promise<SharedPaymentFile | null> {
  if (!id || !/^[a-f0-9-]{36}$/.test(id)) return null;
  const cache = await caches.open("hostelpalika-shared-payments-v1");
  const key = new URL("/app/_shared-payment/" + id, location.origin).href;
  const response = await cache.match(key);
  if (!response) return null;
  if (Number(response.headers.get("x-shared-at")) < Date.now() - 3600000) {
    await cache.delete(key); return null;
  }
  const blob = await response.blob();
  const file = { uri: URL.createObjectURL(blob), fileName: decodeURIComponent(response.headers.get("x-file-name") ?? "receipt"),
    mimeType: blob.type, fileSize: blob.size };
  await cache.delete(key);
  return acceptsSharedPayment(file) ? file : null;
}
