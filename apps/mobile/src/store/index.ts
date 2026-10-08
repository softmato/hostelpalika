import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  combineReducers,
  configureStore,
  type UnknownAction,
} from "@reduxjs/toolkit";
import {
  FLUSH,
  PAUSE,
  PERSIST,
  PURGE,
  REGISTER,
  REHYDRATE,
  createMigrate,
  createTransform,
  persistReducer,
  persistStore,
} from "redux-persist";

import authReducer, { type AuthState } from "@/store/slices/authSlice";
import notificationsReducer from "@/store/slices/notificationsSlice";
import savedReducer from "@/store/slices/savedSlice";
import uiReducer from "@/store/slices/uiSlice";

/**
 * Changing a slice's `initialState` does **not** change what an existing
 * install sees: rehydration writes the stored value straight over it. So a new
 * default only reaches a phone that already has the app if a migration puts it
 * there.
 *
 * This is easy to miss because it works perfectly on a fresh install and not at
 * all on the device you have been testing with all day.
 *
 * Bump `PERSIST_VERSION` and add an entry here whenever a persisted default
 * changes meaning.
 */
export const PERSIST_VERSION = 3;

export const migrations = {
  /** Theme default moved from "system" to "light" — see uiSlice. */
  2: (state: unknown) => {
    const previous = state as { ui?: { themePreference?: string } } | undefined;

    if (!previous) return previous;

    return { ...previous, ui: { ...previous.ui, themePreference: "light" } };
  },
  /**
   * Calendar default moved from "AD" to "BS" — see uiSlice.
   *
   * This overwrites the stored value, which means it also overwrites an owner
   * who had deliberately chosen "AD" while the setting was admin-only. That is
   * the deliberate trade and it is the same one migration 2 made for the theme:
   * a stored value that only ever came from the old default is indistinguishable
   * from one somebody picked, and leaving every existing install on Gregorian
   * would mean the new default reached only phones installing the app for the
   * first time. The setting is one tap away in Settings › Appearance.
   */
  3: (state: unknown) => {
    const previous = state as { ui?: { calendarPreference?: string } } | undefined;

    if (!previous) return previous;

    return { ...previous, ui: { ...previous.ui, calendarPreference: "BS" } };
  },
};

/**
 * Two auth fields must never survive a relaunch.
 *
 * `accessToken` because its durable home is SecureStore — writing it to
 * AsyncStorage too would put a bearer token in plaintext on disk, which is the
 * whole reason SecureStore is there.
 *
 * `isReady` because it gates the splash. Rehydrating it as `true` would skip
 * the boot gate entirely, and the app would route off a cached account without
 * ever checking whether the tokens behind it still exist.
 */
const volatileAuthFields = createTransform<AuthState, AuthState>(
  (state) => ({ ...state, accessToken: null, isReady: false }),
  (state) => ({ ...state, accessToken: null, isReady: false }),
  { whitelist: ["auth"] },
);

const combined = combineReducers({
  auth: authReducer,
  notifications: notificationsReducer,
  saved: savedReducer,
  ui: uiReducer,
});

/**
 * Wipes every slice back to its initial state.
 *
 * Dispatched on logout and on a failed refresh. Phones get shared — a resident
 * signs out, a cook signs in — so leaving one account's cached dashboard in
 * memory is a data leak, not just a stale render. Pair with `persistor.purge()`
 * to clear what is already on disk.
 */
export const RESET_STORE = "store/reset" as const;
export const resetStore = () => ({ type: RESET_STORE });

type AppState = ReturnType<typeof combined>;

const rootReducer = (state: AppState | undefined, action: UnknownAction): AppState => {
  if (action.type === RESET_STORE) {
    // Returning undefined state makes every reducer fall back to its initial
    // value; `_persist` is re-attached by persistReducer.
    const fresh = combined(undefined, action);

    /*
     * Except one field: biometric stays on for an account on this phone across
     * a sign-out. It only ever matches that account's id, so the same person
     * signing back in keeps it and nobody else gets anything of theirs. Kept
     * here rather than re-dispatched after the reset, so no path through a
     * reset — sign-out, a dead refresh, a boot with no tokens — can drop it.
     */
    return {
      ...fresh,
      auth: { ...fresh.auth, biometricUserId: state?.auth.biometricUserId ?? null },
    };
  }

  return combined(state, action);
};

const persistedReducer = persistReducer<AppState>(
  {
    key: "root",
    storage: AsyncStorage,
    /*
     * `auth` is persisted for one reason: the boot gate needs the cached
     * account to choose a route before the first frame. `accessToken` and
     * `isReady` are stripped below — the token's durable home is SecureStore,
     * and `isReady` must start false on every launch or the gate is skipped.
     */
    transforms: [volatileAuthFields],
    // redux-persist types migrations against its own `PersistedState`, which is
    // looser than this root state; the cast is at the boundary, not inside.
    migrate: createMigrate(migrations as Parameters<typeof createMigrate>[0]),
    version: PERSIST_VERSION,
    /*
     * `saved` needs no migration entry: a key absent from storage rehydrates to
     * the reducer's `initialState`, so an existing install simply starts with an
     * empty favourites list. Migrations are only for a persisted default whose
     * *meaning* changed. `notifications` is the same case.
     */
    whitelist: ["auth", "notifications", "saved", "ui"],
  },
  rootReducer,
);

/**
 * How long a dev-only state scan may take before Redux Toolkit calls it a
 * problem.
 *
 * The default is 32ms, and rehydration blows through it on a cold start: the
 * whole persisted tree — account, favourites, preferences — lands in one
 * `REHYDRATE`, and both the serializable and immutable checks walk every node of
 * it on a JS thread that is also mounting the first screen. The 35ms this prints
 * on a debug build is the check itself being slow, not the store, and both
 * middlewares are stripped from production entirely, so the number describes
 * nothing a user will ever experience.
 *
 * Raised rather than switched off, because the checks are worth keeping: a
 * `Date` or a class instance smuggled into a slice is a real bug and this is
 * what catches it. 128ms is far enough above the rehydration spike to stay
 * quiet and still low enough that a genuinely pathological state tree trips it.
 *
 * `ignoredActions` below is a different lever and does not help here — it
 * exempts redux-persist's own action *payloads*, not the state scan that
 * follows them.
 */
const DEV_CHECK_WARN_AFTER_MS = 128;

export const store = configureStore({
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      immutableCheck: { warnAfter: DEV_CHECK_WARN_AFTER_MS },
      serializableCheck: {
        ignoredActions: [FLUSH, PAUSE, PERSIST, PURGE, REGISTER, REHYDRATE],
        warnAfter: DEV_CHECK_WARN_AFTER_MS,
      },
    }),
  reducer: persistedReducer,
});

export const persistor = persistStore(store);

export type AppDispatch = typeof store.dispatch;
export type RootState = ReturnType<typeof store.getState>;
