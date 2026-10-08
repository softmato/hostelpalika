import { describe, expect, it } from "vitest";

import { resetStore, store } from "@/store/index";
import { clearAuth, setBiometricUserId } from "@/store/slices/authSlice";

/**
 * Sign out, sign back in, and biometric is still on — the PIN alone was the
 * bug. The flag only ever matches its own account id, so keeping it gives
 * another account nothing.
 */
describe("biometric survives a sign-out", () => {
  it("is kept by the store reset and by clearAuth", () => {
    store.dispatch(setBiometricUserId("user-1"));

    store.dispatch(resetStore());
    expect(store.getState().auth.biometricUserId).toBe("user-1");
    expect(store.getState().auth.account).toBeNull();

    store.dispatch(clearAuth());
    expect(store.getState().auth.biometricUserId).toBe("user-1");
  });
});
