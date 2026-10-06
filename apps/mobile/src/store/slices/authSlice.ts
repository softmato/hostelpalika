import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

import type { ApiUser } from "@/lib/auth-api";

export type SessionEndReason = "EXPIRED" | "SUSPENDED" | null;

export type AuthState = {
  /** Kept in memory only; the durable copy is in SecureStore. */
  accessToken: string | null;
  /**
   * The cached account. Persisted, because the splash gate has to pick a route
   * from it before any network call — that is what removes the login flash.
   */
  account: ApiUser | null;
  /**
   * The account that turned the fingerprint lock on for this phone. Persisted so
   * the lock is decided on the first frame — see `lib/app-lock.ts`.
   */
  biometricUserId: string | null;
  /** RESIDENT only. `null` means "not known yet", which is not the same as false. */
  isResidentActivated: boolean | null;
  /** True once the boot gate has finished; the router waits on this. */
  isReady: boolean;
  sessionEndReason: SessionEndReason;
};

const initialState: AuthState = {
  accessToken: null,
  account: null,
  biometricUserId: null,
  isReady: false,
  isResidentActivated: null,
  sessionEndReason: null,
};

const authSlice = createSlice({
  initialState,
  name: "auth",
  reducers: {
    clearAuth(state) {
      state.accessToken = null;
      state.account = null;
      state.biometricUserId = null;
      state.isResidentActivated = null;
    },
    setAccessToken(state, action: PayloadAction<string>) {
      state.accessToken = action.payload;
    },
    setBiometricUserId(state, action: PayloadAction<string | null>) {
      state.biometricUserId = action.payload;
    },
    setAccount(state, action: PayloadAction<ApiUser>) {
      state.account = action.payload;
    },
    setReady(state, action: PayloadAction<boolean>) {
      state.isReady = action.payload;
    },
    setResidentActivated(state, action: PayloadAction<boolean>) {
      state.isResidentActivated = action.payload;
    },
    setSession(
      state,
      action: PayloadAction<{ accessToken: string; account: ApiUser }>,
    ) {
      state.accessToken = action.payload.accessToken;
      state.account = action.payload.account;
      state.sessionEndReason = null;
    },
    setSessionEndReason(state, action: PayloadAction<SessionEndReason>) {
      state.sessionEndReason = action.payload;
    },
  },
});

export const {
  clearAuth,
  setAccessToken,
  setAccount,
  setBiometricUserId,
  setReady,
  setResidentActivated,
  setSession,
  setSessionEndReason,
} = authSlice.actions;

export default authSlice.reducer;
