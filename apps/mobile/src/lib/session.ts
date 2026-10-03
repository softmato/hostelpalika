/**
 * Token storage.
 *
 * Tokens live in SecureStore (Keychain / EncryptedSharedPreferences), never in
 * AsyncStorage — AsyncStorage is a plaintext file on disk and is included in
 * device backups.
 *
 * The *account* is cached separately in AsyncStorage via redux-persist, because
 * the splash gate has to read it synchronously-ish to pick a route before the
 * first frame, and it holds nothing secret: a name, a role, two booleans.
 */

import { receiptNative } from "./receipt-native";

import * as SecureStore from "expo-secure-store";

export const SECURE_KEYS = {
  ACCESS_TOKEN: "hh_access_token",
  REFRESH_TOKEN: "hh_refresh_token",
} as const;

export type StoredTokens = {
  accessToken: string;
  refreshToken: string;
};

export async function readTokens(): Promise<StoredTokens | null> {
  if (receiptNative) {
    const saved = await receiptNative.readSession();
    if (saved) return saved;
  }
  const [accessToken, refreshToken] = await Promise.all([
    SecureStore.getItemAsync(SECURE_KEYS.ACCESS_TOKEN),
    SecureStore.getItemAsync(SECURE_KEYS.REFRESH_TOKEN),
  ]);

  if (!accessToken || !refreshToken) {
    return null;
  }

  const tokens = { accessToken, refreshToken };
  if (receiptNative) {
    await receiptNative.writeSession(tokens);
    await Promise.all(Object.values(SECURE_KEYS).map((key) => SecureStore.deleteItemAsync(key)));
  }
  return tokens;
}

export async function writeTokens(tokens: StoredTokens) {
  if (receiptNative) { await receiptNative.writeSession(tokens); return; }
  await Promise.all([
    SecureStore.setItemAsync(SECURE_KEYS.ACCESS_TOKEN, tokens.accessToken),
    SecureStore.setItemAsync(SECURE_KEYS.REFRESH_TOKEN, tokens.refreshToken),
  ]);
}

export async function writeAccessToken(accessToken: string) {
  if (receiptNative) {
    const saved = await receiptNative.readSession();
    if (saved) await receiptNative.writeSession({ ...saved, accessToken });
    return;
  }
  await SecureStore.setItemAsync(SECURE_KEYS.ACCESS_TOKEN, accessToken);
}

export async function clearTokens() {
  if (receiptNative) await receiptNative.writeSession(null);
  await Promise.all([
    SecureStore.deleteItemAsync(SECURE_KEYS.ACCESS_TOKEN),
    SecureStore.deleteItemAsync(SECURE_KEYS.REFRESH_TOKEN),
  ]);
}
