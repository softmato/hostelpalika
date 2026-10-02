import { Ionicons } from "@expo/vector-icons";
import {
  type BarcodeScanningResult,
  CameraView,
  useCameraPermissions,
} from "expo-camera";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useRef, useState } from "react";
import { Linking, Pressable, View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { useAppDispatch, useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import {
  activationCodeError,
  normalizeActivationCode,
  parseScannedCode,
} from "@/lib/activation-code";
import { readApiError } from "@/lib/api-contract";
import { activateResident } from "@/lib/auth-api";
import { endSession, startSession } from "@/lib/auth-session";
import { openConfirm } from "@/lib/confirm";
import { collectDeviceInfo, collectSessionInfo } from "@/lib/device-info";
import { toastSuccess } from "@/lib/toast";
import { setResidentActivated } from "@/store/slices/authSlice";
import { APP_NAME } from "@/constants/branding";

/**
 * Redeeming the QR code that turns an account into a resident.
 *
 * ## Activation is a sign-in, not a form submission
 *
 * `POST /resident/activate` runs `requireApiPrincipal` first — so the user is
 * *already signed in* when they get here — and ends with
 * `issueSessionForUser`, returning fresh tokens and the updated user whose role
 * is now `RESIDENT`. The token in memory still names the old role, so the
 * response has to go through `startSession` exactly as a login would. Anything
 * less leaves the app holding a token that says `PUBLIC` while the server has
 * moved on, and the next request 403s on a screen that just said "success".
 *
 * ## Manual entry is not a fallback, it is the other half
 *
 * QR scanning fails on cracked screens, in bad light, on a code printed small
 * and photocopied, and on a phone whose camera permission was refused once
 * months ago. The code is eight characters; typing it is a few seconds. Both
 * paths run the same `submit`.
 *
 * ## The scanned payload is a URL, not the code
 *
 * See `lib/activation-code.ts` — the QR encodes
 * `<app>/resident-activation?code=…` because the same image is printed for the
 * web flow.
 *
 * ## There is a way out
 *
 * The boot gate sends an unactivated resident straight here on every launch, so
 * without sign-out this screen is a trap for anyone whose code has expired —
 * and an expired code is the normal case for someone who left it a week.
 */
export default function ActivateScreen() {
  const dispatch = useAppDispatch();
  const account = useAppSelector((state) => state.auth.account);
  const { colors } = useAppTheme();

  const [permission, requestPermission] = useCameraPermissions();
  const [torch, setTorch] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  /*
   * Kept apart from `error`, which renders under the manual field: a wrong QR
   * held up to the camera has to be answered *at the camera*, and the field is
   * a couple of hundred pixels further down. Everything the server says lands
   * in `error` instead, next to the code it rejected.
   */
  const [scanHint, setScanHint] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  /*
   * A ref, not the `submitting` state: `onBarcodeScanned` fires on every frame
   * the code is in view — several times before React has re-rendered with
   * `submitting: true` — and each of those would be a second POST that burns
   * the code and 409s on itself.
   */
  const claiming = useRef(false);

  async function submit(raw: string) {
    if (claiming.current) {
      return;
    }

    const candidate = normalizeActivationCode(raw);
    const problem = activationCodeError(candidate);

    if (problem) {
      setError(problem);
      return;
    }

    claiming.current = true;
    setError(null);
    setSubmitting(true);

    try {
      const result = await activateResident({
        code: candidate,
        deviceInfo: await collectDeviceInfo(),
        sessionInfo: collectSessionInfo(),
      });

      await startSession(result);

      /*
       * `startSession` asks the server whether this resident is activated. We
       * already know — the call that just returned is what activated them — and
       * if that extra request fails on a flaky connection the flag stays null
       * and the gate sends them straight back to this screen. So the authoritative
       * answer is written locally rather than re-fetched.
       */
      dispatch(setResidentActivated(true));

      toastSuccess("You're all set", "Your hostel account is active.");
      router.replace("/(resident)");
    } catch (caught) {
      setError(
        readApiError(caught, "Could not activate with that code. Try again."),
      );
      claiming.current = false;
      setSubmitting(false);
    }
  }

  function onScan({ data }: BarcodeScanningResult) {
    if (claiming.current) {
      return;
    }

    const scanned = parseScannedCode(data);

    if (!scanned) {
      // A constant string, so the frames that follow bail out of re-rendering
      // instead of thrashing while the wrong QR is held up to the lens.
      setScanHint(`That's not a ${APP_NAME} activation code.`);
      return;
    }

    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setScanHint(null);
    setCode(scanned);
    void submit(scanned);
  }

  function signOut() {
    openConfirm({
      confirmLabel: "Sign out",
      destructive: true,
      message: "You can activate later — ask your hostel to send the code again.",
      onConfirm: () => {
        void endSession().finally(() => router.replace("/(browse)"));
      },
      title: "Sign out?",
    });
  }

  // Reachable directly, and the endpoint needs a principal. Better to say so
  // than to let the POST come back 401 with no explanation.
  if (!account) {
    return (
      <Screen header={<AppBar title="Activate your account" />}>
        <Card className="gap-3">
          <Text variant="muted">
            Sign in first — an activation code links your hostel room to your
            account, so we need to know whose account it is.
          </Text>
          <Button label="Sign in" onPress={() => router.replace("/(auth)/login")} />
        </Card>
      </Screen>
    );
  }

  return (
    <Screen
      header={
        <AppBar
          actions={
            <Pressable
              accessibilityLabel="Sign out"
              accessibilityRole="button"
              hitSlop={10}
              onPress={signOut}
            >
              <Text className="text-primary" variant="label">
                Sign out
              </Text>
            </Pressable>
          }
          subtitle={account.name}
          title="Activate your account"
        />
      }
      scroll
    >
      <View className="gap-6">
        <Text variant="muted">
          Scan the QR code from your hostel — it&apos;s in your activation email,
          or on the sticker your warden gave you.
        </Text>

        <Scanner
          busy={submitting}
          onRequestPermission={requestPermission}
          onScan={onScan}
          onToggleTorch={() => setTorch((current) => !current)}
          permission={permission}
          scanHint={scanHint}
          torch={torch}
        />

        <View className="flex-row items-center gap-3">
          <View className="h-px flex-1 bg-border" />
          <Text variant="caption">or enter it by hand</Text>
          <View className="h-px flex-1 bg-border" />
        </View>

        <View className="gap-4">
          <Input
            autoCapitalize="characters"
            autoCorrect={false}
            editable={!submitting}
            error={error}
            hint="Eight characters, letters and numbers."
            label="Activation code"
            maxLength={32}
            onChangeText={(value) => {
              setCode(normalizeActivationCode(value));

              if (error) {
                setError(null);
              }
            }}
            onSubmitEditing={() => void submit(code)}
            placeholder="AB12CD34"
            returnKeyType="go"
            value={code}
          />

          <Button
            label="Activate"
            loading={submitting}
            onPress={() => void submit(code)}
            size="lg"
          />
        </View>

        <Card className="gap-2">
          <Text variant="label">No code, or it stopped working?</Text>
          <Text variant="muted">
            Codes expire, and each one can only be used once. Ask your hostel
            admin to send a new one to{" "}
            {account.email ?? "the email on your account"}.
          </Text>
        </Card>

        <View className="flex-row items-start gap-2">
          <Ionicons
            color={colors.mutedForeground}
            name="lock-closed-outline"
            size={14}
            style={{ marginTop: 2 }}
          />
          <Text className="flex-1" variant="caption">
            Your camera is only used to read the code. Nothing is recorded or
            uploaded.
          </Text>
        </View>
      </View>
    </Screen>
  );
}

/**
 * The camera pane and its three other states.
 *
 * `undetermined` deliberately does **not** auto-prompt on mount: a dialogue
 * that appears before the user has read what the screen is for is the one that
 * gets refused, and a refusal with "don't ask again" cannot be undone from
 * inside the app. So the prompt is behind a button, and the permanent refusal
 * routes to system settings instead of a dead camera frame.
 */
function Scanner({
  busy,
  onRequestPermission,
  onScan,
  onToggleTorch,
  permission,
  scanHint,
  torch,
}: {
  busy: boolean;
  onRequestPermission: () => void;
  onScan: (result: BarcodeScanningResult) => void;
  onToggleTorch: () => void;
  permission: ReturnType<typeof useCameraPermissions>[0];
  /** Why the last read was ignored, shown over the frame it was read in. */
  scanHint: string | null;
  torch: boolean;
}) {
  const { colors } = useAppTheme();

  if (!permission) {
    // The hook has not reported yet — a frame or two, and an empty box of the
    // right size beats a spinner that flashes.
    return <ScannerFrame />;
  }

  if (!permission.granted) {
    return (
      <ScannerFrame>
        <View className="items-center gap-3 px-6">
          <Ionicons color={colors.mutedForeground} name="camera-outline" size={28} />
          <Text className="text-center" variant="muted">
            {permission.canAskAgain
              ? "Allow the camera to scan your activation code, or type it below."
              : `Camera access is off for ${APP_NAME}. Turn it on in Settings, or type the code below.`}
          </Text>
          <Button
            label={permission.canAskAgain ? "Allow camera" : "Open settings"}
            onPress={
              permission.canAskAgain
                ? onRequestPermission
                : () => void Linking.openSettings()
            }
            size="sm"
            variant="outline"
          />
        </View>
      </ScannerFrame>
    );
  }

  return (
    <View className="overflow-hidden rounded-2xl border border-border bg-black">
      <CameraView
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        enableTorch={torch}
        facing="back"
        // Stops mid-flight: the code has been claimed, and a second read would
        // race the navigation away from this screen.
        onBarcodeScanned={busy ? undefined : onScan}
        style={{ height: 260, width: "100%" }}
      />

      {/* The aiming square. Purely a guide — the scanner reads the whole frame,
          and a viewfinder people believe is a hard boundary makes them fight to
          fit the code inside it. */}
      <View
        className="absolute inset-0 items-center justify-center"
        style={{ pointerEvents: "none" }}
      >
        <View className="h-40 w-40 rounded-2xl border-2 border-white/80" />
      </View>

      {scanHint ? (
        <View className="absolute inset-x-0 top-0 bg-black/70 px-4 py-2">
          <Text className="text-center text-xs font-medium text-white">{scanHint}</Text>
        </View>
      ) : null}

      <Pressable
        accessibilityLabel={torch ? "Turn off the torch" : "Turn on the torch"}
        accessibilityRole="button"
        accessibilityState={{ selected: torch }}
        className="absolute bottom-3 right-3 h-11 w-11 items-center justify-center rounded-full bg-black/60 active:opacity-70"
        onPress={onToggleTorch}
      >
        <Ionicons color="#ffffff" name={torch ? "flashlight" : "flashlight-outline"} size={20} />
      </Pressable>
    </View>
  );
}

function ScannerFrame({ children }: { children?: React.ReactNode }) {
  return (
    <View
      className="items-center justify-center rounded-2xl border border-border bg-muted"
      style={{ height: 260 }}
    >
      {children}
    </View>
  );
}
