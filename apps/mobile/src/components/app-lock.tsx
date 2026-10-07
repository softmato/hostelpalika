import { Image } from "expo-image";
import { requireOptionalNativeModule } from "expo-modules-core";
import { router, usePathname } from "expo-router";
import {
  Delete,
  FingerprintPattern,
  KeyRound,
  LockKeyhole,
  type LucideIcon,
  Mail,
} from "lucide-react-native";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, AppState, BackHandler, Pressable, StyleSheet, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import Animated, {
  FadeIn,
  FadeInDown,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
  ZoomIn,
} from "react-native-reanimated";

import { bootSplashGone } from "@/components/brand-splash";
import { PersonAvatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ListRow } from "@/components/ui/list-row";
import { Sheet } from "@/components/ui/sheet";
import { Text } from "@/components/ui/text";
import { Toggle } from "@/components/ui/toggle";
import { APP_NAME, logo } from "@/constants/branding";
import { ROLE } from "@/constants/roles";
import { useAppDispatch, useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useSystemInsets } from "@/hooks/use-system-insets";
import { readApiError, readApiErrorCode } from "@/lib/api-contract";
import {
  armFingerprint,
  canOfferLock,
  checkLockPin,
  disarmFingerprint,
  type FingerprintStatus,
  fingerprintStatus,
  hasMailbox,
  isAuthenticating,
  isLocked,
  type LockPinProof,
  maskEmail,
  onAppStateChange,
  removeLockPin,
  saveLockPin,
  sendLockCode,
  subscribeToLock,
  unlockApp,
  unlockWithFingerprint,
  unlockWithPin,
  verifyLockCode,
} from "@/lib/app-lock";
import type { ApiUser } from "@/lib/auth-api";
import { isCompleteOtpCode, normalizeOtpCode } from "@/lib/auth-form";
import { endSession } from "@/lib/auth-session";
import { toastError, toastInfo, toastSuccess } from "@/lib/toast";
import { persistor, store } from "@/store";
import { setAccount, setBiometricUserId } from "@/store/slices/authSlice";

/** `modules/hostelhub-app-lock` — keeps the portal out of the Recents thumbnail. */
const appLockNative = requireOptionalNativeModule<{
  setRecentsHidden(hidden: boolean): Promise<void>;
}>("HostelHubAppLock");

/** True for the process's first lock only — that one waits for the splash. */
let coldStart = true;
/** "Remind me later" lasts until the app is next opened from cold. */
let offerDismissed = false;

/**
 * The lock is on for this account on this phone: it has a PIN (account-wide),
 * or — from before the PIN — turned the fingerprint lock on here. And it is
 * still allowed (an owner can switch cooks off).
 */
export function useLockEnabled() {
  return useAppSelector((state) => {
    const account = state.auth.account;
    return (
      account !== null &&
      canOfferLock(account) &&
      (account.hasLockPin === true || state.auth.biometricUserId === account.id)
    );
  });
}

/** The fingerprint opens this account's lock on this phone. */
function useFingerOnPhone() {
  return useAppSelector(
    (state) => state.auth.account !== null && state.auth.biometricUserId === state.auth.account.id,
  );
}

function pinFailure(caught: unknown) {
  return {
    blocked: readApiErrorCode(caught) === "LOCK_PIN_BLOCKED",
    message: readApiError(caught, "That PIN did not work."),
  };
}

/**
 * Drawn over everything — outside the sheet provider, after the toasts — so
 * no sheet, toast or screen can surface above it. See `lib/app-lock.ts`.
 */
export function AppLockHost() {
  const account = useAppSelector((state) => state.auth.account);
  const enabled = useLockEnabled();
  const locked = useSyncExternalStore(subscribeToLock, isLocked);

  // Signing in just proved who this is: the lock is for the next open. Heard
  // straight from the store, before React renders the signed-in frame, so
  // that frame is never the lock.
  useEffect(() => {
    let lastId = store.getState().auth.account?.id ?? null;
    return store.subscribe(() => {
      const id = store.getState().auth.account?.id ?? null;
      if (lastId === null && id !== null) unlockApp();
      lastId = id;
    });
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", onAppStateChange);
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    void appLockNative?.setRecentsHidden(enabled).catch(() => {});
  }, [enabled]);

  if (!enabled || !locked || !account) return null;

  return <LockScreen account={account} />;
}

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "finger", "0", "back"] as const;

/**
 * Four boxes and the app's own number pad — the phone keyboard never opens for
 * a PIN. The bank apps' lock, in our green. A new `error` shakes the boxes.
 */
function PinPad({
  busy = false,
  error,
  onChange,
  onComplete,
  onFingerprint,
  value,
}: {
  busy?: boolean;
  error?: string | null;
  onChange: (value: string) => void;
  onComplete: (value: string) => void;
  onFingerprint?: () => void;
  value: string;
}) {
  const { colors } = useAppTheme();
  const offset = useSharedValue(0);
  const shake = useAnimatedStyle(() => ({ transform: [{ translateX: offset.value }] }));

  useEffect(() => {
    if (!error) return;
    offset.set(withSequence(
      withTiming(-10, { duration: 50 }),
      withTiming(10, { duration: 50 }),
      withTiming(-7, { duration: 50 }),
      withTiming(7, { duration: 50 }),
      withTiming(0, { duration: 50 }),
    ));
  }, [error, offset]);

  function press(key: (typeof KEYS)[number]) {
    if (busy) return;
    if (key === "finger") {
      onFingerprint?.();
      return;
    }
    if (key === "back") {
      onChange(value.slice(0, -1));
      return;
    }
    if (value.length >= 4) return;
    const next = value + key;
    onChange(next);
    if (next.length === 4) onComplete(next);
  }

  return (
    <View className="gap-4">
      <Animated.View
        accessibilityLabel={`${value.length} of 4 digits entered`}
        className="flex-row justify-center gap-3"
        style={shake}
      >
        {[0, 1, 2, 3].map((index) => {
          const active = index === Math.min(value.length, 3) && !busy;
          return (
            <View
              className={`h-14 w-14 items-center justify-center rounded-2xl border-2 ${
                active ? "border-brand bg-card" : "border-transparent bg-muted"
              }`}
              key={index}
            >
              {index < value.length ? (
                <View className="h-3.5 w-3.5 rounded-full bg-foreground" />
              ) : null}
            </View>
          );
        })}
      </Animated.View>

      <View className="min-h-5 items-center justify-center">
        {busy ? (
          <ActivityIndicator color={colors.brand} size="small" />
        ) : error ? (
          <Text className="text-center text-destructive" variant="caption">
            {error}
          </Text>
        ) : null}
      </View>

      <View className="flex-row flex-wrap">
        {KEYS.map((key) => (
          <View className="w-1/3 p-1" key={key}>
            {key === "finger" && !onFingerprint ? null : (
              <Pressable
                accessibilityLabel={
                  key === "back" ? "Delete" : key === "finger" ? "Use fingerprint" : key
                }
                accessibilityRole="button"
                className="h-16 items-center justify-center rounded-2xl active:bg-brand-soft"
                disabled={busy}
                onPress={() => press(key)}
              >
                {key === "back" ? (
                  <Delete color={colors.mutedForeground} size={26} strokeWidth={1.8} />
                ) : key === "finger" ? (
                  <FingerprintPattern color={colors.brand} size={30} strokeWidth={1.6} />
                ) : (
                  <Text className="text-2xl font-semibold text-foreground" variant={null}>
                    {key}
                  </Text>
                )}
              </Pressable>
            )}
          </View>
        ))}
      </View>
    </View>
  );
}

/** The tinted icon, one line and the line under it — the head of every lock step. */
function StepHeading({
  icon: Icon,
  subtitle,
  title,
}: {
  icon: LucideIcon;
  subtitle?: string;
  title: string;
}) {
  const { colors } = useAppTheme();

  return (
    <View className="items-center gap-2">
      <View className="h-16 w-16 items-center justify-center rounded-full bg-brand-soft">
        <Icon color={colors.brand} size={28} strokeWidth={1.8} />
      </View>
      <Text className="text-center" variant="title">
        {title}
      </Text>
      {subtitle ? (
        <Text className="text-center" variant="muted">
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
}

/** "Choose a PIN", then "Enter it again" — hands over the PIN once both match. */
function NewPinSteps({
  busy,
  error,
  onPin,
}: {
  busy: boolean;
  error?: string | null;
  onPin: (pin: string) => void;
}) {
  const [first, setFirst] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [mismatch, setMismatch] = useState<string | null>(null);

  function complete(pin: string) {
    // A beat, so the fourth box is seen filling before the pad clears.
    setTimeout(() => {
      setValue("");
      if (first === null) {
        setFirst(pin);
      } else if (pin !== first) {
        setFirst(null);
        setMismatch("The two PINs did not match. Choose it again.");
      } else {
        onPin(pin);
      }
    }, 150);
  }

  return (
    <View className="gap-6">
      <StepHeading
        icon={KeyRound}
        subtitle={
          first === null
            ? `4 digits. It opens ${APP_NAME}, and your portal on the website.`
            : "The same 4 digits again."
        }
        title={first === null ? "Choose a PIN" : "Enter it again"}
      />
      <PinPad
        busy={busy}
        error={mismatch ?? error}
        onChange={(next) => {
          setValue(next);
          setMismatch(null);
        }}
        onComplete={complete}
        value={value}
      />
    </View>
  );
}

/**
 * Forgot the PIN: a code to the account's own email — or, for a minted cook
 * login with no inbox, the password. Hands the proof on unspent; the server
 * checks it when the new PIN (or "off") is sent with it.
 */
function RecoveryStep({
  account,
  busy,
  error,
  onProof,
  then,
}: {
  account: ApiUser;
  busy: boolean;
  error?: string | null;
  onProof: (proof: LockPinProof) => void;
  then: string;
}) {
  const [password, setPassword] = useState("");

  return (
    <View className="gap-5">
      <StepHeading icon={hasMailbox(account) ? Mail : KeyRound} subtitle={then} title="Forgot your PIN?" />
      {error ? (
        <Text className="text-center text-destructive" variant="caption">
          {error}
        </Text>
      ) : null}
      {hasMailbox(account) ? (
        <EmailCodeForm
          email={account.email}
          onCode={(challengeId, code) => onProof({ challengeId, code })}
        />
      ) : (
        <View className="gap-3">
          <Input
            autoComplete="current-password"
            label="Your password"
            onChangeText={setPassword}
            onSubmitEditing={() => password && onProof({ password })}
            secure
            value={password}
          />
          <Button
            disabled={!password}
            label="Next"
            loading={busy}
            onPress={() => onProof({ password })}
          />
        </View>
      )}
    </View>
  );
}

type LockStatus = "idle" | "prompting" | "failed" | "changed" | "saving";

const STATUS_COPY: Record<LockStatus, string> = {
  changed: "The fingerprints on this phone changed. Confirm it is you with an email code.",
  failed: "Not recognised. Tap the fingerprint to try again.",
  idle: "Touch the fingerprint sensor to open.",
  prompting: "Touch the fingerprint sensor to open.",
  saving: "Code accepted. Touch the sensor to save your fingerprint.",
};

function LockScreen({ account }: { account: ApiUser }) {
  const dispatch = useAppDispatch();
  const { colors } = useAppTheme();
  const insets = useSystemInsets();
  const mailbox = hasMailbox(account);
  const hasPin = account.hasLockPin === true;
  const fingerOnPhone = useFingerOnPhone();
  const [status, setStatus] = useState<LockStatus>("idle");
  const [withCode, setWithCode] = useState(false);
  const prompting = useRef(false);
  const [splash] = useState(() => (coldStart ? bootSplashGone() : Promise.resolve()));
  // Mounted once the splash is gone, so the entrance plays where it can be seen.
  const [revealed, setRevealed] = useState(!coldStart);

  // The PIN side.
  const [mode, setMode] = useState<"pin" | "recover" | "new">("pin");
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [proof, setProof] = useState<LockPinProof>({});
  const fingerChanged = useRef(false);

  async function tryFingerprint() {
    // "background", not "!== active": iOS can report "unknown" on the first frame.
    if (prompting.current || !isLocked() || AppState.currentState === "background") return;
    prompting.current = true;
    setStatus("prompting");
    const result = await unlockWithFingerprint();
    prompting.current = false;
    if (result === "changed" && hasPin) {
      // Someone added or removed a finger: the PIN decides, then the new set is saved.
      fingerChanged.current = true;
      setPinError("The fingerprints on this phone changed. Enter your PIN.");
      setStatus("idle");
      return;
    }
    if (result === "changed" && mailbox) setWithCode(true);
    setStatus(result === "unlocked" ? "idle" : result);
  }

  async function rearmIfChanged() {
    if (!fingerChanged.current) return;
    if (!(await armFingerprint())) {
      dispatch(setBiometricUserId(null));
      toastInfo("Fingerprint is off on this phone", "Your PIN still opens the app.");
    }
  }

  // Ask on its own: after the splash on a cold start, and on every real return.
  useEffect(() => {
    coldStart = false;
    let wentAway = false;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void splash.then(() => {
      if (disposed) return;
      setRevealed(true);
      if (fingerOnPhone) timer = setTimeout(() => void tryFingerprint(), 350);
    });
    const subscription = AppState.addEventListener("change", (state) => {
      // Some phones pause the app for their own fingerprint sheet; re-asking
      // when it closes would loop a cancelled prompt forever.
      if (isAuthenticating()) return;
      if (state === "background") {
        wentAway = true;
        clearTimeout(timer);
      } else if (state === "active" && wentAway) {
        wentAway = false;
        // A beat first: a quick return lifts the lock instead (`onAppStateChange`).
        if (fingerOnPhone) timer = setTimeout(() => void tryFingerprint(), 350);
      }
    });
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      BackHandler.exitApp();
      return true;
    });

    return () => {
      disposed = true;
      clearTimeout(timer);
      subscription.remove();
      back.remove();
    };
    // Once per lock; `tryFingerprint` reads only refs and module state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submitPin(value: string) {
    setChecking(true);
    setPinError(null);
    try {
      await unlockWithPin(value);
      await rearmIfChanged();
    } catch (caught) {
      setPin("");
      setChecking(false);
      const failure = pinFailure(caught);
      if (failure.blocked) {
        setMode("recover");
      }
      setPinError(failure.message);
    }
  }

  async function saveForgotten(newPin: string) {
    setChecking(true);
    setPinError(null);
    try {
      await saveLockPin(newPin, proof);
      unlockApp();
      await rearmIfChanged();
      toastSuccess("New PIN saved", "It opens the app and the website.");
    } catch (caught) {
      setChecking(false);
      // A wrong or expired code is the thing to fix, not the PIN.
      setMode("recover");
      setPinError(readApiError(caught, "Could not save the PIN."));
    }
  }

  async function onCodeVerified() {
    if (status === "changed") {
      setStatus("saving");
      if (!(await armFingerprint())) {
        dispatch(setBiometricUserId(null));
        toastInfo("Fingerprint lock is off", "Turn it on again in Settings.");
      }
    }
    unlockApp();
  }

  function signOut() {
    // Leave first: the lock lifts when the session ends, and must lift onto login.
    router.replace({
      params: mailbox ? { identifier: account.email } : {},
      pathname: "/(auth)/login",
    });
    void endSession();
  }

  const header = (
    <>
      <Animated.View className="items-center gap-2" entering={FadeInDown.duration(420)}>
        <Image contentFit="contain" source={logo.mark} style={{ height: 48, width: 48 }} />
        <Text variant="title">{APP_NAME}</Text>
      </Animated.View>

      <Animated.View
        className="mt-5 flex-row items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3"
        entering={FadeInDown.delay(80).duration(420)}
      >
        <PersonAvatar image={account.image} name={account.name} />
        <View className="flex-1">
          <Text numberOfLines={1} variant="subtitle">
            {account.name}
          </Text>
          {mailbox ? (
            <Text numberOfLines={1} variant="caption">
              {maskEmail(account.email)}
            </Text>
          ) : null}
        </View>
      </Animated.View>
    </>
  );

  const signOutLink = (
    <Pressable accessibilityRole="button" className="self-center py-2" onPress={signOut}>
      <Text variant="muted">
        Not you? <Text className="text-primary" variant="label">Sign out</Text>
      </Text>
    </Pressable>
  );

  return (
    <Animated.View
      accessibilityViewIsModal
      exiting={FadeOut.duration(220)}
      style={[StyleSheet.absoluteFill, styles.cover, { backgroundColor: colors.background }]}
    >
      {revealed ? (
        <KeyboardAwareScrollView
          bottomOffset={24}
          contentContainerStyle={{
            flexGrow: 1,
            paddingBottom: Math.max(insets.bottom, 16) + 8,
            paddingHorizontal: 24,
            paddingTop: insets.top + 32,
          }}
          keyboardShouldPersistTaps="handled"
        >
          {header}

          {hasPin ? (
            <Animated.View className="mt-6 flex-1 gap-4" entering={FadeIn.duration(220)} key={mode}>
              {mode === "pin" ? (
                <>
                  <Text className="text-center" variant="subtitle">
                    {fingerOnPhone ? "Enter your PIN or use your fingerprint" : "Enter your PIN"}
                  </Text>
                  <PinPad
                    busy={checking}
                    error={pinError}
                    onChange={(next) => {
                      setPin(next);
                      setPinError(null);
                    }}
                    onComplete={(value) => void submitPin(value)}
                    onFingerprint={fingerOnPhone ? () => void tryFingerprint() : undefined}
                    value={pin}
                  />
                  <Pressable
                    accessibilityRole="button"
                    className="self-center py-2"
                    onPress={() => {
                      setPinError(null);
                      setMode("recover");
                    }}
                  >
                    <Text className="text-primary" variant="label">
                      Forgot PIN?
                    </Text>
                  </Pressable>
                </>
              ) : mode === "recover" ? (
                <>
                  <RecoveryStep
                    account={account}
                    busy={checking}
                    error={pinError}
                    onProof={(next) => {
                      setProof(next);
                      setPinError(null);
                      setMode("new");
                    }}
                    then="Then you choose a new PIN."
                  />
                  <Button
                    label="Back to PIN"
                    onPress={() => {
                      setPinError(null);
                      setMode("pin");
                    }}
                    variant="ghost"
                  />
                </>
              ) : (
                <NewPinSteps busy={checking} error={pinError} onPin={(value) => void saveForgotten(value)} />
              )}
              <View className="mt-auto pt-2">{signOutLink}</View>
            </Animated.View>
          ) : withCode && mailbox ? (
            // Fingerprint-only lock from before the PIN.
            <Animated.View className="mt-8 gap-4" entering={FadeIn.duration(220)}>
              {status === "changed" || status === "saving" ? (
                <Text variant="muted">{STATUS_COPY[status]}</Text>
              ) : null}
              <EmailCodeForm email={account.email} onVerified={onCodeVerified} />
              {status !== "changed" && status !== "saving" ? (
                <Button
                  icon={FingerprintPattern}
                  label="Use fingerprint"
                  onPress={() => {
                    setWithCode(false);
                    void tryFingerprint();
                  }}
                  variant="ghost"
                />
              ) : null}
              {signOutLink}
            </Animated.View>
          ) : status === "changed" ? (
            // No inbox to send a code to (a minted cook login): the password is the way back.
            <Animated.View className="mt-12 flex-1 gap-4" entering={FadeIn.duration(220)}>
              <Text className="text-center" variant="muted">
                The fingerprints on this phone changed. Sign out, then sign in again with your
                password.
              </Text>
              <Button label="Sign out" onPress={signOut} />
            </Animated.View>
          ) : (
            <>
              <View className="mt-12 flex-1 items-center gap-4">
                <Animated.View entering={ZoomIn.delay(160).springify().damping(14)}>
                  <Pressable
                    accessibilityLabel="Unlock with fingerprint"
                    accessibilityRole="button"
                    className="h-32 w-32 items-center justify-center rounded-full bg-brand-soft active:opacity-80"
                    onPress={() => void tryFingerprint()}
                  >
                    <FingerprintPattern color={colors.brand} size={60} strokeWidth={1.6} />
                  </Pressable>
                </Animated.View>
                <Text
                  className={status === "failed" ? "text-center text-destructive" : "text-center"}
                  variant="muted"
                >
                  {STATUS_COPY[status]}
                </Text>
              </View>
              <View className="mt-8 gap-3">
                {mailbox ? (
                  <Button
                    icon={Mail}
                    label="Use email code instead"
                    onPress={() => setWithCode(true)}
                    variant="outline"
                  />
                ) : null}
                {signOutLink}
              </View>
            </>
          )}
        </KeyboardAwareScrollView>
      ) : null}
    </Animated.View>
  );
}

/**
 * A code mailed to the account's own address. Nothing is sent until the
 * button is pressed, so a lock does not mail anyone unasked.
 *
 * `onVerified`: the code is checked (and spent) here — the fingerprint-only
 * lock's recovery. `onCode`: handed on unspent, for the server to check with
 * the new PIN or the "off" it comes with.
 */
export function EmailCodeForm({
  email,
  onCode,
  onVerified,
}: {
  email: string;
  onCode?: (challengeId: string, code: string) => void;
  onVerified?: () => Promise<void> | void;
}) {
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [checking, setChecking] = useState(false);

  async function send() {
    setSending(true);
    setError(null);
    try {
      const challenge = await sendLockCode();
      setChallengeId(challenge.challengeId);
      setCode(__DEV__ && challenge.devCode ? challenge.devCode : "");
    } catch (caught) {
      setError(readApiError(caught, "Could not send the code."));
    } finally {
      setSending(false);
    }
  }

  async function confirm() {
    if (!challengeId || !isCompleteOtpCode(code)) {
      setError("Enter the 6-digit code.");
      return;
    }
    if (onCode) {
      onCode(challengeId, code);
      return;
    }
    setChecking(true);
    setError(null);
    try {
      await verifyLockCode(challengeId, code);
      await onVerified?.();
    } catch (caught) {
      setError(readApiError(caught, "That code did not work."));
    } finally {
      setChecking(false);
    }
  }

  if (!challengeId) {
    return (
      <View className="gap-3">
        <Text className="text-center" variant="muted">
          We will email a 6-digit code to {maskEmail(email)}.
        </Text>
        {error ? (
          <Text className="text-destructive" variant="caption">
            {error}
          </Text>
        ) : null}
        <Button icon={Mail} label="Send code" loading={sending} onPress={send} />
      </View>
    );
  }

  return (
    <View className="gap-3">
      <Input
        autoComplete="one-time-code"
        autoFocus
        error={error}
        hint={`Sent to ${maskEmail(email)}`}
        keyboardType="number-pad"
        label="Code"
        maxLength={6}
        onChangeText={(value) => setCode(normalizeOtpCode(value))}
        onSubmitEditing={() => void confirm()}
        placeholder="123456"
        returnKeyType="go"
        textContentType="oneTimeCode"
        value={code}
      />
      <Button label={onCode ? "Next" : "Confirm"} loading={checking} onPress={confirm} />
      <Pressable
        accessibilityRole="button"
        className="self-center py-2"
        disabled={sending}
        onPress={() => void send()}
      >
        <Text className="text-primary" variant="label">
          {sending ? "Sending…" : "Send a new code"}
        </Text>
      </Pressable>
    </View>
  );
}

/**
 * Turning the lock on: choose the PIN twice, then the fingerprint (when the
 * phone has one) is asked for straight away. `intro` adds the ask in front —
 * the cold-open offer; Settings starts at the PIN.
 */
function LockSetupSheet({
  intro,
  onClose,
  open,
}: {
  intro: boolean;
  onClose: () => void;
  open: boolean;
}) {
  const dispatch = useAppDispatch();
  const account = useAppSelector((state) => state.auth.account);
  const fingerOnPhone = useFingerOnPhone();
  const [started, setStarted] = useState(!intro);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(pin: string) {
    if (!account) return;
    setBusy(true);
    setError(null);
    try {
      await saveLockPin(pin);
    } catch (caught) {
      setBusy(false);
      setError(readApiError(caught, "Could not save the PIN."));
      return;
    }
    // Open first, then flag — otherwise the lock would draw over the screen that turned it on.
    unlockApp();
    dispatch(setAccount({ ...account, hasLockPin: true }));
    let finger = fingerOnPhone;
    if (!finger && (await armFingerprint())) {
      dispatch(setBiometricUserId(account.id));
      finger = true;
    }
    await persistor.flush();
    setBusy(false);
    toastSuccess(
      "App lock is on",
      finger ? "Fingerprint or PIN, every time the app opens." : "Your PIN, every time the app opens.",
    );
    onClose();
  }

  return (
    <Sheet fitContent onClose={onClose} open={open}>
      {started ? (
        <View className="pb-2 pt-4">
          <NewPinSteps busy={busy} error={error} onPin={(pin) => void save(pin)} />
        </View>
      ) : (
        <>
          <View className="pb-2 pt-4">
            <StepHeading
              icon={LockKeyhole}
              subtitle={
                fingerOnPhone
                  ? "Your fingerprint keeps opening the app. A PIN opens it when the finger will not — and opens your portal on the website."
                  : `Every time ${APP_NAME} opens, use your fingerprint or a 4-digit PIN. The same PIN opens your portal on the website.`
              }
              title={fingerOnPhone ? "Add a PIN" : "Lock the app"}
            />
          </View>
          <View className="gap-3 pt-4">
            <Button label="Remind me later" onPress={onClose} variant="outline" />
            <Button icon={LockKeyhole} label="Set up" onPress={() => setStarted(true)} />
          </View>
        </>
      )}
    </Sheet>
  );
}

/** The ask, on every cold open until the account has a PIN. */
export function AppLockOffer() {
  const pathname = usePathname();
  const account = useAppSelector((state) => state.auth.account);
  const ready = useAppSelector((state) => state.auth.isReady);
  const activated = useAppSelector((state) => state.auth.isResidentActivated);
  const [open, setOpen] = useState(false);

  const wanted =
    ready &&
    !offerDismissed &&
    account?.hasLockPin !== true &&
    // Only a resident has an activation; an account that was one once keeps the stale `false`.
    (account?.role !== ROLE.RESIDENT || activated !== false) &&
    canOfferLock(account) &&
    !pathname.startsWith("/login") &&
    !pathname.startsWith("/activate");

  useEffect(() => {
    if (!wanted) return;
    // Let the portal settle under the splash before asking anything.
    const timer = setTimeout(() => setOpen(true), 1500);
    return () => clearTimeout(timer);
  }, [wanted]);

  function later() {
    offerDismissed = true;
    setOpen(false);
  }

  return <LockSetupSheet intro onClose={later} open={open && wanted} />;
}

/**
 * Changing the PIN, or turning the lock off: the current PIN first — or
 * "Forgot PIN?", the email code (the password, for a login with no inbox).
 */
function PinProofSheet({
  mode,
  onClose,
  open,
}: {
  mode: "change" | "off";
  onClose: () => void;
  open: boolean;
}) {
  const dispatch = useAppDispatch();
  const account = useAppSelector((state) => state.auth.account);
  const [step, setStep] = useState<"current" | "recover" | "new">("current");
  const [pin, setPin] = useState("");
  const [proof, setProof] = useState<LockPinProof>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!account) return null;

  async function turnOff(next: LockPinProof) {
    if (!account) return;
    await removeLockPin(next);
    await disarmFingerprint();
    dispatch(setBiometricUserId(null));
    dispatch(setAccount({ ...account, hasLockPin: false }));
    await persistor.flush();
    toastSuccess("App lock is off", "On every phone you use, and on the website.");
    onClose();
  }

  async function onCurrent(value: string) {
    setBusy(true);
    setError(null);
    try {
      if (mode === "off") {
        await turnOff({ currentPin: value });
        return;
      }
      await checkLockPin(value);
      setProof({ currentPin: value });
      setStep("new");
    } catch (caught) {
      setPin("");
      const failure = pinFailure(caught);
      if (failure.blocked) setStep("recover");
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function onRecovered(next: LockPinProof) {
    setError(null);
    if (mode === "change") {
      setProof(next);
      setStep("new");
      return;
    }
    setBusy(true);
    try {
      await turnOff(next);
    } catch (caught) {
      setError(readApiError(caught, "That did not work."));
    } finally {
      setBusy(false);
    }
  }

  async function onNewPin(value: string) {
    setBusy(true);
    setError(null);
    try {
      await saveLockPin(value, proof);
      toastSuccess("PIN changed", "Use the new one in the app and on the website.");
      onClose();
    } catch (caught) {
      setError(readApiError(caught, "Could not save the PIN."));
      setStep(proof.currentPin ? "current" : "recover");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet fitContent onClose={onClose} open={open}>
      <View className="gap-5 pb-2 pt-4">
        {step === "current" ? (
          <>
            <StepHeading
              icon={LockKeyhole}
              subtitle={mode === "off" ? "The lock turns off on every phone and the website." : undefined}
              title={mode === "off" ? "Enter your PIN to turn the lock off" : "Enter your current PIN"}
            />
            <PinPad
              busy={busy}
              error={error}
              onChange={(next) => {
                setPin(next);
                setError(null);
              }}
              onComplete={(value) => void onCurrent(value)}
              value={pin}
            />
            <Pressable
              accessibilityRole="button"
              className="self-center py-1"
              onPress={() => {
                setError(null);
                setStep("recover");
              }}
            >
              <Text className="text-primary" variant="label">
                Forgot PIN?
              </Text>
            </Pressable>
          </>
        ) : step === "recover" ? (
          <RecoveryStep
            account={account}
            busy={busy}
            error={error}
            onProof={(next) => void onRecovered(next)}
            then={mode === "off" ? "Then the lock turns off." : "Then you choose a new PIN."}
          />
        ) : (
          <NewPinSteps busy={busy} error={error} onPin={(value) => void onNewPin(value)} />
        )}
      </View>
    </Sheet>
  );
}

/**
 * Settings → Security. The lock (the account's PIN) on or off, the
 * fingerprint for this phone, and changing the PIN. A fingerprint-only lock
 * from before the PIN is offered "Add a PIN" and turns off as it always did.
 */
export function AppLockSetting() {
  const dispatch = useAppDispatch();
  const { colors } = useAppTheme();
  const account = useAppSelector((state) => state.auth.account);
  const enabled = useLockEnabled();
  const fingerOnPhone = useFingerOnPhone();
  const [status, setStatus] = useState<FingerprintStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState<"setup" | "change" | "off" | "legacy-off" | null>(null);
  // Held apart from `sheet`, so the closing sheet keeps its own heading.
  const [proofMode, setProofMode] = useState<"change" | "off">("change");
  // Bumped on every opening: a fresh sheet starts at its first step.
  const [opening, setOpening] = useState(0);

  function openSheet(next: "setup" | "change" | "off" | "legacy-off") {
    setOpening((value) => value + 1);
    setSheet(next);
  }

  useEffect(() => {
    void fingerprintStatus().then(setStatus);
  }, []);

  if (!account || !canOfferLock(account)) return null;

  const hasPin = account.hasLockPin === true;
  const mailbox = hasMailbox(account);

  async function setFinger(next: boolean) {
    if (!account) return;
    setBusy(true);
    if (!next) {
      await disarmFingerprint();
      dispatch(setBiometricUserId(null));
    } else if (await armFingerprint()) {
      dispatch(setBiometricUserId(account.id));
      toastSuccess("Fingerprint is on", "It opens the app on this phone.");
    } else {
      toastError("Fingerprint not confirmed");
    }
    await persistor.flush();
    setBusy(false);
  }

  /** The fingerprint-only lock's way off: the email code, or the finger for a login with no inbox. */
  async function legacyOff() {
    await disarmFingerprint();
    dispatch(setBiometricUserId(null));
    setSheet(null);
    toastSuccess("App lock is off");
  }

  async function onLockToggle(next: boolean) {
    if (next) {
      openSheet("setup");
    } else if (hasPin) {
      setProofMode("off");
      openSheet("off");
    } else if (mailbox) {
      openSheet("legacy-off");
    } else if ((await unlockWithFingerprint()) === "failed") {
      toastError("Fingerprint not confirmed");
    } else {
      await legacyOff();
    }
  }

  const fingerSubtitle = fingerOnPhone
    ? "Opens the app on this phone"
    : status === "none"
      ? "Save a fingerprint in your phone's settings first"
      : "Off on this phone";

  return (
    <View>
      <SectionHeader
        subtitle={
          mailbox
            ? `Forgot your PIN? A code to ${maskEmail(account.email)} resets it`
            : "Forgot your PIN? Your password resets it"
        }
        title="Security"
      />
      <Card>
        <ListRow
          icon="lock-closed"
          iconBgColor={colors.primary}
          right={
            <Toggle
              accessibilityLabel="App lock"
              disabled={busy}
              onChange={(next) => void onLockToggle(next)}
              value={enabled}
            />
          }
          subtitle={
            !enabled
              ? "Off"
              : hasPin
                ? "PIN or fingerprint every time the app opens"
                : "Fingerprint every time the app opens"
          }
          title="App lock"
        />
        {enabled && hasPin ? (
          <>
            <ListRow
              icon="finger-print"
              iconBgColor={colors.primary}
              right={
                <Toggle
                  accessibilityLabel="Unlock with fingerprint"
                  disabled={busy || (!fingerOnPhone && status === "none")}
                  onChange={(next) => void setFinger(next)}
                  value={fingerOnPhone}
                />
              }
              subtitle={fingerSubtitle}
              title="Fingerprint"
            />
            <ListRow
              icon="keypad"
              iconBgColor={colors.primary}
              onPress={() => {
                setProofMode("change");
                openSheet("change");
              }}
              subtitle="Also opens your portal on the website"
              title="Change PIN"
            />
          </>
        ) : enabled ? (
          <ListRow
            icon="keypad"
            iconBgColor={colors.primary}
            onPress={() => openSheet("setup")}
            subtitle="Opens the app when the finger will not, and the website"
            title="Add a PIN"
          />
        ) : null}
      </Card>

      <LockSetupSheet
        intro={false}
        key={`setup-${opening}`}
        onClose={() => setSheet(null)}
        open={sheet === "setup"}
      />
      <PinProofSheet
        key={`proof-${opening}`}
        mode={proofMode}
        onClose={() => setSheet(null)}
        open={sheet === "change" || sheet === "off"}
      />
      {mailbox ? (
        <Sheet
          fitContent
          onClose={() => setSheet(null)}
          open={sheet === "legacy-off"}
          title="Turn off app lock"
        >
          <EmailCodeForm email={account.email} onVerified={legacyOff} />
        </Sheet>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  cover: { elevation: 9000, zIndex: 9000 },
});
