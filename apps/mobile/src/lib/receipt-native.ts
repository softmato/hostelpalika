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
};
export const receiptNative = Platform.OS === "web" ? null
  : requireOptionalNativeModule<ReceiptNative>("ReceiptSheet");
