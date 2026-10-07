import { Image } from "expo-image";
import { requireOptionalNativeModule } from "expo-modules-core";
import { router, usePathname } from "expo-router";
import { FingerprintPattern, Mail } from "lucide-react-native";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AppState, BackHandler, Pressable, StyleSheet, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import Animated, { FadeIn, FadeInDown, FadeOut, ZoomIn } from "react-native-reanimated";

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
import { readApiError } from "@/lib/api-contract";
import {
  armFingerprint,
  canOfferLock,
  disarmFingerprint,
  type FingerprintStatus,
  fingerprintStatus,
  hasFingerprint,
  hasMailbox,
  isAuthenticating,
  isLocked,
  maskEmail,
  onAppStateChange,
  sendLockCode,
  subscribeToLock,
  unlockApp,
  unlockWithFingerprint,
  verifyLockCode,
} from "@/lib/app-lock";
import type { ApiUser } from "@/lib/auth-api";
import { isCompleteOtpCode, normalizeOtpCode } from "@/lib/auth-form";
import { endSession } from "@/lib/auth-session";
import { toastError, toastInfo, toastSuccess } from "@/lib/toast";
import { persistor } from "@/store";
import { setBiometricUserId } from "@/store/slices/authSlice";

/** `modules/hostelhub-app-lock` — keeps the portal out of the Recents thumbnail. */
const appLockNative = requireOptionalNativeModule<{
  setRecentsHidden(hidden: boolean): Promise<void>;
}>("HostelHubAppLock");

/** True for the process's first lock only — that one waits for the splash. */
let coldStart = true;
/** "Remind me later" lasts until the app is next opened from cold. */
let offerDismissed = false;

/** On for this account on this phone — and still allowed (an owner can switch cooks off). */
function useLockEnabled() {
  return useAppSelector(
    (state) =>
      state.auth.account !== null &&
      state.auth.biometricUserId === state.auth.account.id &&
      canOfferLock(state.auth.account),
  );
}

/** Turns the lock on: the fingerprint prompt is the confirmation. */
function useTurnOnLock() {
  const dispatch = useAppDispatch();

  return async (accountId: string) => {
    if (!(await armFingerprint())) return false;
    // Open first, then flag — otherwise the lock would draw over the screen that turned it on.
    unlockApp();
    dispatch(setBiometricUserId(accountId));
    await persistor.flush();
    toastSuccess("Fingerprint lock is on", "We will ask every time the app opens.");
    return true;
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
  const [status, setStatus] = useState<LockStatus>("idle");
  const [withCode, setWithCode] = useState(false);
  const prompting = useRef(false);
  const [splash] = useState(() => (coldStart ? bootSplashGone() : Promise.resolve()));
  // Mounted once the splash is gone, so the entrance plays where it can be seen.
  const [revealed, setRevealed] = useState(!coldStart);

  async function tryFingerprint() {
    // "background", not "!== active": iOS can report "unknown" on the first frame.
    if (prompting.current || !isLocked() || AppState.currentState === "background") return;
    prompting.current = true;
    setStatus("prompting");
    const result = await unlockWithFingerprint();
    prompting.current = false;
    if (result === "changed" && mailbox) setWithCode(true);
    setStatus(result === "unlocked" ? "idle" : result);
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
      timer = setTimeout(() => void tryFingerprint(), 350);
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
        timer = setTimeout(() => void tryFingerprint(), 350);
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
            paddingTop: insets.top + 48,
          }}
          keyboardShouldPersistTaps="handled"
        >
          <Animated.View
            className="items-center gap-3"
            entering={FadeInDown.duration(420)}
          >
            <Image contentFit="contain" source={logo.mark} style={{ height: 64, width: 64 }} />
            <Text variant="display">{APP_NAME}</Text>
          </Animated.View>

          <Animated.View
            className="mt-8 flex-row items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3"
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

          {withCode && mailbox ? (
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
          )}

          <View className="mt-8 gap-3">
            {!withCode && mailbox && status !== "changed" ? (
              <Button
                icon={Mail}
                label="Use email code instead"
                onPress={() => setWithCode(true)}
                variant="outline"
              />
            ) : null}
            {status === "changed" && !mailbox ? null : (
              <Pressable accessibilityRole="button" className="self-center py-2" onPress={signOut}>
                <Text variant="muted">
                  Not you? <Text className="text-primary" variant="label">Sign out</Text>
                </Text>
              </Pressable>
            )}
          </View>
        </KeyboardAwareScrollView>
      ) : null}
    </Animated.View>
  );
}

/**
 * A code mailed to the account's own address — the lock's recovery, and what
 * turning it off asks for. Nothing is sent until the button is pressed, so a
 * lock that opens on a changed finger set does not mail anyone unasked.
 */
export function EmailCodeForm({
  email,
  onVerified,
}: {
  email: string;
  onVerified: () => Promise<void> | void;
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
    setChecking(true);
    setError(null);
    try {
      await verifyLockCode(challengeId, code);
      await onVerified();
    } catch (caught) {
      setError(readApiError(caught, "That code did not work."));
    } finally {
      setChecking(false);
    }
  }

  if (!challengeId) {
    return (
      <View className="gap-3">
        <Text variant="muted">We will email a 6-digit code to {maskEmail(email)}.</Text>
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
      <Button label="Confirm" loading={checking} onPress={confirm} />
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
 * The ask, on every cold open until it is answered with "Turn on". Shaped like
 * the bank apps' update sheet: one tinted icon, one line, two stacked buttons.
 */
export function FingerprintOffer() {
  const { colors } = useAppTheme();
  const pathname = usePathname();
  const account = useAppSelector((state) => state.auth.account);
  const ready = useAppSelector((state) => state.auth.isReady);
  const activated = useAppSelector((state) => state.auth.isResidentActivated);
  const enabled = useLockEnabled();
  const turnOn = useTurnOnLock();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wanted =
    ready &&
    !enabled &&
    !offerDismissed &&
    // Only a resident has an activation; an account that was one once keeps the stale `false`.
    (account?.role !== ROLE.RESIDENT || activated !== false) &&
    canOfferLock(account) &&
    !pathname.startsWith("/login") &&
    !pathname.startsWith("/activate");

  useEffect(() => {
    if (!wanted) return;
    let cancelled = false;
    // Let the portal settle under the splash before asking anything.
    const timer = setTimeout(() => {
      void hasFingerprint().then((available) => {
        if (!cancelled && available) setOpen(true);
      });
    }, 1500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [wanted]);

  function later() {
    offerDismissed = true;
    setOpen(false);
  }

  async function accept() {
    if (!account) return;
    setBusy(true);
    setError(null);
    const done = await turnOn(account.id);
    setBusy(false);
    if (done) {
      offerDismissed = true;
      setOpen(false);
    } else {
      setError("Fingerprint not confirmed. Try again.");
    }
  }

  return (
    <Sheet fitContent onClose={later} open={open && wanted}>
      <View className="items-center gap-3 pb-2 pt-4">
        <View className="h-28 w-28 items-center justify-center rounded-full bg-brand-soft">
          <FingerprintPattern color={colors.brand} size={52} strokeWidth={1.6} />
        </View>
        <Text className="text-center" variant="title">
          Open with your fingerprint
        </Text>
        <Text className="text-center" variant="muted">
          We will ask for it every time {APP_NAME} opens.
          {hasMailbox(account)
            ? ` If it stops working, a code to ${maskEmail(account.email)} lets you in.`
            : " If it stops working, sign in again with your password."}
        </Text>
        {error ? (
          <Text className="text-center text-destructive" variant="caption">
            {error}
          </Text>
        ) : null}
      </View>
      <View className="gap-3 pt-4">
        <Button label="Remind me later" onPress={later} variant="outline" />
        <Button icon={FingerprintPattern} label="Turn on" loading={busy} onPress={accept} />
      </View>
    </Sheet>
  );
}

/**
 * Settings → Security. On needs the finger. Off needs the email code — or,
 * for a login with no inbox, the finger again.
 */
export function FingerprintLockSetting() {
  const dispatch = useAppDispatch();
  const { colors } = useAppTheme();
  const account = useAppSelector((state) => state.auth.account);
  const enabled = useLockEnabled();
  const turnOn = useTurnOnLock();
  const [status, setStatus] = useState<FingerprintStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [turningOff, setTurningOff] = useState(false);

  useEffect(() => {
    void fingerprintStatus().then(setStatus);
  }, []);

  if (!account || !canOfferLock(account)) return null;

  // Hidden used to be the answer when the phone could not do it, which left nobody able to say why.
  const usable = enabled || status === "ready" || status === null;

  const mailbox = hasMailbox(account);

  async function turnOff() {
    await disarmFingerprint();
    dispatch(setBiometricUserId(null));
    setTurningOff(false);
    toastSuccess("Fingerprint lock is off");
  }

  async function onToggle(next: boolean) {
    if (!account) return;
    if (!next && mailbox) {
      setTurningOff(true);
      return;
    }
    setBusy(true);
    if (next) {
      await turnOn(account.id);
    } else if ((await unlockWithFingerprint()) === "failed") {
      toastError("Fingerprint not confirmed");
    } else {
      await turnOff();
    }
    setBusy(false);
  }

  return (
    <View>
      <SectionHeader
        subtitle={
          mailbox
            ? `Recovery codes go to ${maskEmail(account.email)}`
            : "Locked out? Sign in again with your password"
        }
        title="Security"
      />
      <Card>
        <ListRow
          icon="finger-print"
          iconBgColor={colors.primary}
          right={
            <Toggle
              accessibilityLabel="Fingerprint lock"
              disabled={busy || !usable}
              onChange={(next) => void onToggle(next)}
              value={enabled}
            />
          }
          subtitle={
            usable
              ? "Asked every time the app opens"
              : status === "weak"
                ? "This phone's fingerprint cannot lock apps"
                : "Save a fingerprint in your phone's settings first"
          }
          title="Fingerprint lock"
        />
      </Card>

      {mailbox ? (
        <Sheet
          fitContent
          onClose={() => setTurningOff(false)}
          open={turningOff}
          title="Turn off fingerprint lock"
        >
          <EmailCodeForm email={account.email} onVerified={turnOff} />
        </Sheet>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  cover: { elevation: 9000, zIndex: 9000 },
});
