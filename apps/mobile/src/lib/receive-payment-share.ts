import * as Sharing from "expo-sharing";
import { File } from "expo-file-system";
import { acceptsSharedPayment, normalizeSharedPayment, type SharedPaymentFile } from "./shared-payment";
export async function receivePaymentShare(_id?: string): Promise<SharedPaymentFile | null> {
  const items = await Sharing.getResolvedSharedPayloadsAsync();
  if (items.length !== 1) return null;
  const item = items[0];
  const uri = item.contentUri || (/^(file|content):/.test(item.value) ? item.value : "");
  if (!uri) return null;
  // Check the copied bytes: Android providers can report SIZE=null as zero.
  const local = new File(uri);
  if (!local.exists) throw new Error("The shared receipt could not be copied. Share it again.");
  const file = normalizeSharedPayment({ uri, fileName: item.originalName,
    mimeType: item.contentMimeType || item.mimeType, fileSize: local.size });
  if (!acceptsSharedPayment(file)) return null;
  Sharing.clearSharedPayloads();
  return file;
}
