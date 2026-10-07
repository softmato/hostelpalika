import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";
import type { StoredTokens } from "./session";
type ReceiptNative = {
  readSession(): Promise<StoredTokens | null>;
  writeSession(tokens: StoredTokens | null): Promise<void>;
  refreshSession(baseUrl: string): Promise<string | null>;
  configure(baseUrl: string, hostelId: string | null): Promise<void>;
  getAutoSave(key: string): Promise<boolean>;
  setAutoSave(key: string, enabled: boolean): Promise<void>;
  /** Android only: who is signed in, read by the share activity before any sheet — staff auto-save skips the sheet; residents always get it. */
  setShareAccount?(role: string | null, autoKey: string | null): Promise<void>;
};
/** One key per account + hostel; the bundled receipt sheet builds the same string. */
export const receiptAutoKey = (account: { id: string; hostelIds: string[] }, hostelId: string | null) =>
  `hostelpalika.receipt-auto:${account.id}:${hostelId || account.hostelIds[0] || ""}`;
export const receiptNative = Platform.OS === "web" ? null
  : requireOptionalNativeModule<ReceiptNative>("ReceiptSheet");
