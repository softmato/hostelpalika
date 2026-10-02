import * as Sharing from "expo-sharing";
import { acceptsSharedPayment, type SharedPaymentFile } from "./shared-payment";
export async function receivePaymentShare(_id?: string): Promise<SharedPaymentFile | null> {
  const items = await Sharing.getResolvedSharedPayloadsAsync();
  if (items.length !== 1) return null;
  const item = items[0];
  const file = { uri: item.contentUri ?? "", fileName: item.originalName,
    mimeType: item.contentMimeType ?? item.mimeType, fileSize: item.contentSize ?? undefined };
  if (!acceptsSharedPayment(file)) return null;
  Sharing.clearSharedPayloads();
  return file;
}
