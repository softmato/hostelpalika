import { Ionicons } from "@expo/vector-icons";
import { useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import { useFocusEffect } from "expo-router";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  useWindowDimensions,
  View,
} from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import { Button } from "@/components/ui/button";
import { QrCamera } from "@/components/qr-camera";
import { Input } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { Text } from "@/components/ui/text";
import { useSystemInsets } from "@/hooks/use-system-insets";
import {
  formatResidentIdInput,
  normalizeResidentId,
  residentIdError,
} from "@/lib/resident-id";
import { APP_NAME } from "@/constants/branding";

/**
 * The camera surface both card readers are built from.
 *
 * ## Why it is shared, and why it is *parameterised* rather than shared whole
 *
 * There are two scanners in this app pointed at the same object. **Look them
 * up** (`manage/scan`) answers "who is this person" for somebody already living
 * here. **Register them** (`manage/resident/new`) starts an intake for somebody
 * who is not. The camera, the aiming window, the torch, the manual-entry sheet
 * and the every-frame parse guard are identical in both, and a copy of that is a
 * copy that drifts.
 *
 * What must **not** be identical is the way they look. A warden holding a card
 * up has half a second to notice which one they opened, and the failure is
 * silent in both directions: looking somebody up on the register screen wastes a
 * minute, while starting an intake for a resident who already lives here spends
 * a bed and creates a duplicate. So `tone`, `title`, `subtitle` and `step` are
 * required rather than defaulted — a new caller has to state what it is, and
 * cannot inherit the other screen's identity by leaving a prop off.
 *
 * The tones are the two the palette allows: `neutral` is white brackets on the
 * feed, `brand` is the green ones with a green header rule. Nothing else here
 * carries colour, and neither reference app's palette is anywhere near it.
 *
 * ## Everything that was load-bearing on the original screen is still here
 *
 * `handled` is a ref, not state: the camera reports a card held still over and
 * over, and a flag React has not re-rendered yet would let the same card fire the callback
 * three times. It is lowered on **focus** rather than on mount, because pushing
 * a screen on top leaves this one mounted underneath and an empty-deps effect
 * would never run again — the second scan of a session would do nothing at all.
 *
 * And nothing leaves the phone until the payload is ours. `normalizeResidentId`
 * mirrors the server's parse precisely so a bus ticket held up to the lens costs
 * no request at all.
 *
 * ## The half-second after a card reads used to look like nothing happening
 *
 * A good scan buzzes and hands the id to the caller — and on the intake screen
 * the caller then spends a network round trip fetching the profile. The camera
 * stayed on a live feed with the sweep still travelling, which is the screen's
 * own signal for *still looking*, so a warden who felt the buzz and saw no
 * change did the one thing that cannot help: held the card up again. `busy`
 * closes that window. See `ScanWindow`.
 */

export type ScannerTone = "brand" | "neutral";

export function IdScanner({
  busy,
  extraAction,
  hint,
  manualTitle,
  onClose,
  onResidentId,
  step,
  subtitle,
  title,
  tone,
}: {
  /**
   * What the caller is doing with the id it was just handed — `"Fetching their
   * details"` — or null while the camera is still looking.
   *
   * It is the label rather than a boolean because the wait is the caller's, and
   * only the caller knows what it is for: the lookup screen navigates on the
   * spot and never passes one, while the intake spends a network round trip
   * here before the form appears. A boolean would let a caller claim the screen
   * is busy without saying why, which on a full-bleed camera is a frozen picture
   * with no explanation.
   */
  busy?: string | null;
  /** An escape hatch under the keypad button — "register without a card", say. */
  extraAction?: ReactNode;
  /** Set by the caller when a *valid* id was rejected downstream. */
  hint?: string | null;
  manualTitle: string;
  onClose: () => void;
  onResidentId: (residentId: string) => void;
  /** e.g. "Step 1 of 3". Rendered above the title; the lookup screen omits it. */
  step?: string;
  subtitle: string;
  title: string;
  tone: ScannerTone;
}) {
  const insets = useSystemInsets();
  const window = useWindowDimensions();

  const [permission, requestPermission] = useCameraPermissions();
  const [torch, setTorch] = useState(false);
  const [localHint, setLocalHint] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [typedError, setTypedError] = useState<string | null>(null);
  // Off while a pushed screen covers this one: a camera left running underneath
  // keeps the sensor busy and the torch lit.
  const [focused, setFocused] = useState(true);

  const handled = useRef(false);

  useFocusEffect(
    useCallback(() => {
      handled.current = false;
      setLocalHint(null);
      setFocused(true);

      return () => setFocused(false);
    }, []),
  );

  /*
   * A caller's hint means the id parsed but the lookup refused it — a provider's
   * card, an unfinished profile. The camera has to start listening again or the
   * warden is stuck holding the next card at a dead screen.
   */
  useEffect(() => {
    if (hint) {
      handled.current = false;
    }
  }, [hint]);

  /** A square, capped so the frame does not swallow a tall phone whole. */
  const windowSize = Math.min(window.width - 48, 320);

  function open(residentId: string) {
    handled.current = true;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    onResidentId(residentId);
  }

  function onScan(data: string) {
    if (handled.current) {
      return;
    }

    const residentId = normalizeResidentId(data);

    if (!residentId) {
      // A constant string, so the frames that follow bail out of re-rendering
      // rather than thrashing while the wrong code is held up to the lens.
      setLocalHint(`That is not a ${APP_NAME} ID card.`);
      return;
    }

    setLocalHint(null);
    open(residentId);
  }

  function submitTyped() {
    const problem = residentIdError(typed);

    if (problem) {
      setTypedError(problem);
      return;
    }

    setManualOpen(false);
    open(normalizeResidentId(typed) as string);
  }

  return (
    <View className="flex-1 bg-black">
      {/*
        The camera fills the screen and everything else floats over it. A preview
        boxed inside a card is what `activate.tsx` does, and it is right there —
        that screen is a form with a scanner on it. This screen *is* the scanner,
        and a viewfinder that does not fill the glass reads as a widget rather
        than as a camera.
      */}
      {permission?.granted ? (
        <QrCamera
          active={focused}
          onCode={onScan}
          style={{ bottom: 0, left: 0, position: "absolute", right: 0, top: 0 }}
          torch={torch}
        />
      ) : null}

      <View
        className="flex-1 justify-between"
        style={{ paddingBottom: insets.bottom + 24, paddingTop: insets.top + 8 }}
      >
        <View className="gap-6 px-5">
          <View className="flex-row items-center justify-between">
            <GlassButton
              icon="chevron-down"
              label="Close the scanner"
              onPress={onClose}
            />

            {permission?.granted ? (
              <GlassButton
                active={torch}
                icon={torch ? "flashlight" : "flashlight-outline"}
                label={torch ? "Turn off the torch" : "Turn on the torch"}
                onPress={() => setTorch((current) => !current)}
              />
            ) : null}
          </View>

          <View className="gap-1">
            {step ? (
              <View className="flex-row">
                {/*
                  The pill is the fastest tell that this is not the other
                  scanner: it is the one element the lookup screen never has, and
                  it sits above the title where the eye lands first.
                */}
                <View
                  className={`rounded-full px-3 py-1 ${
                    tone === "brand" ? "bg-primary" : "bg-white/20"
                  }`}
                >
                  <Text className="text-xs font-bold uppercase tracking-wide text-white">
                    {step}
                  </Text>
                </View>
              </View>
            ) : null}

            <Text className="text-2xl font-bold text-white">{title}</Text>
            <Text className="text-sm text-white/70">{subtitle}</Text>
          </View>
        </View>

        <View className="items-center gap-5 px-5">
          <ScanWindow
            busy={busy ?? null}
            live={Boolean(permission?.granted)}
            message={hint ?? localHint}
            size={windowSize}
            tone={tone}
          />

          {permission && !permission.granted ? (
            <View className="w-full max-w-sm items-center gap-3 rounded-3xl bg-white/10 px-5 py-6">
              <Ionicons color="#ffffff" name="camera-outline" size={26} />
              <Text className="text-center text-sm text-white/80">
                {permission.canAskAgain
                  ? "Allow the camera to read their card, or type the ID underneath it."
                  : `Camera access is off for ${APP_NAME}. Turn it on in Settings, or type the ID printed under the QR.`}
              </Text>
              <Button
                label={permission.canAskAgain ? "Allow camera" : "Open settings"}
                onPress={
                  permission.canAskAgain
                    ? requestPermission
                    : () => void Linking.openSettings()
                }
                size="sm"
              />
            </View>
          ) : null}
        </View>

        {/*
          Inert while the caller is working, rather than removed.

          `handled` already stops the *camera* firing twice, but the keypad and
          whatever the caller hangs under it are a second way in — and typing an
          id during a lookup starts a second one whose answer arrives after the
          first has already moved the screen on. Dimmed and untappable keeps the
          layout still: a row of buttons that vanishes for half a second and
          comes back is a screen that looks like it crashed and recovered.
        */}
        <View
          className="gap-3 px-5"
          style={{ opacity: busy ? 0.4 : 1, pointerEvents: busy ? "none" : "auto" }}
        >
          {/*
            Not a fallback for a broken camera so much as the other half of the
            feature. A cracked screen, a card photocopied small, a permission
            refused months ago with "don't ask again", and an ID read out over
            the phone all end here — and it is ten characters to type.
          */}
          <Pressable
            accessibilityLabel="Type the resident ID instead"
            accessibilityRole="button"
            className="flex-row items-center justify-center gap-2 rounded-2xl border border-white/25 bg-white/10 px-5 py-4 active:opacity-70"
            onPress={() => {
              setTypedError(null);
              setManualOpen(true);
            }}
          >
            <Ionicons color="#ffffff" name="keypad-outline" size={18} />
            <Text className="text-base font-semibold text-white">
              Type the ID instead
            </Text>
          </Pressable>

          {extraAction}

          <View className="flex-row items-start justify-center gap-2">
            <Ionicons
              color="rgba(255,255,255,0.55)"
              name="lock-closed-outline"
              size={13}
              style={{ marginTop: 2 }}
            />
            <Text className="text-xs text-white/55">
              The camera only reads the code. Nothing is recorded or uploaded.
            </Text>
          </View>
        </View>
      </View>

      <Sheet
        footer={<Button label="Look them up" onPress={submitTyped} />}
        onClose={() => setManualOpen(false)}
        open={manualOpen}
        title={manualTitle}
      >
        <View className="gap-4">
          <Text variant="muted">
            It is printed under the QR on their card, and reads like HH-4K7M-9XQ2.
          </Text>
          <Input
            autoCapitalize="characters"
            autoCorrect={false}
            error={typedError}
            label="ID on the card"
            maxLength={16}
            onChangeText={(value) => {
              setTyped(formatResidentIdInput(value));

              if (typedError) {
                setTypedError(null);
              }
            }}
            onSubmitEditing={submitTyped}
            placeholder="HH-4K7M-9XQ2"
            returnKeyType="go"
            value={typed}
          />
        </View>
      </Sheet>

      {/*
        Fixed black rather than a token, and this is the one place where that is
        right: the strip sits over a camera feed, not over a themed surface, so
        `bg-background` would paint a white band across the top of a black screen
        in light mode.
      */}
      <View
        className="absolute inset-x-0 top-0 bg-black/35"
        style={{ height: insets.top, pointerEvents: "none" }}
      />
    </View>
  );
}

/** A round control on glass, for chrome that sits over a camera feed. */
function GlassButton({
  active = false,
  icon,
  label,
  onPress,
}: {
  active?: boolean;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      className={`h-11 w-11 items-center justify-center rounded-full active:opacity-70 ${
        active ? "bg-white" : "bg-black/45"
      }`}
      hitSlop={8}
      onPress={onPress}
    >
      <Ionicons color={active ? "#000000" : "#ffffff"} name={icon} size={20} />
    </Pressable>
  );
}

const SWEEP_MS = 2200;

/**
 * The aiming window: four corner brackets and a bar travelling between them.
 *
 * The brackets are a **guide, not a boundary** — the camera reads the whole
 * frame, and a viewfinder people believe is a hard edge makes them fight to fit
 * the code inside it. Corners rather than a full square say "roughly here" where
 * an unbroken outline says "exactly here"; the reference apps draw them the same
 * way for the same reason.
 *
 * The sweep is not decoration either. A camera preview with a static frame gives
 * no evidence it is running: point it at a wall and a frozen feed looks
 * identical to a live one. The travelling bar is the only thing on screen that
 * says "still looking", and it runs on a Reanimated shared value so it keeps
 * moving on the UI thread while JS is busy parsing the lookup it just fired.
 *
 * ## Which is exactly why it has to stop when the card has been read
 *
 * "Still looking" is a lie once a card has been accepted and the caller has gone
 * to the network for it. The buzz says the code was read and the sweep says the
 * camera wants another one, and a warden reads the second: they lift the card
 * away and hold it back up, into a screen that is already handling the first
 * scan. So `busy` swaps the sweep for the wait it is actually in — the frame
 * fills, and the label names what is being fetched.
 *
 * The spinner is a native `<ActivityIndicator>`, which is the one kind that
 * keeps turning while the JS thread is parsing the very response it is waiting
 * on. `docs/DESIGN.md` prefers skeletons to spinners, and it is right about
 * lists and cards — but there is no content shape to skeletonise over a camera
 * feed, and this wait has a known end rather than an unknown amount of content
 * arriving.
 */
function ScanWindow({
  busy,
  live,
  message,
  size,
  tone,
}: {
  /** What the caller is fetching, or null while the camera is looking. */
  busy: string | null;
  live: boolean;
  /** Why the last read was ignored, printed over the frame it was read in. */
  message: string | null;
  size: number;
  tone: ScannerTone;
}) {
  const progress = useSharedValue(0);

  useEffect(() => {
    if (!live) {
      return;
    }

    progress.value = withRepeat(
      withTiming(1, { duration: SWEEP_MS, easing: Easing.inOut(Easing.ease) }),
      // -1 is forever; `true` reverses, so the bar travels back rather than
      // snapping to the top — a snap reads as a dropped frame.
      -1,
      true,
    );
  }, [live, progress]);

  const sweep = useAnimatedStyle(() => ({
    transform: [{ translateY: progress.value * (size - 2) }],
  }));

  const bracket = `absolute h-9 w-9 ${
    tone === "brand" ? "border-primary" : "border-white"
  }`;

  return (
    <View style={{ height: size, width: size }}>
      {/* Clipped, so the bar cannot travel out past the brackets. */}
      <View className="overflow-hidden rounded-3xl" style={{ height: size, width: size }}>
        {live && !busy ? (
          <Animated.View
            className="absolute inset-x-2 h-0.5 rounded-full bg-primary"
            style={sweep}
          />
        ) : null}

        {busy ? (
          <View className="absolute inset-0 items-center justify-center gap-3 bg-black/70 px-6">
            <ActivityIndicator color="#ffffff" />
            <Text className="text-center text-sm font-semibold text-white">{busy}</Text>
          </View>
        ) : null}
      </View>

      <View className={`${bracket} left-0 top-0 rounded-tl-3xl border-l-4 border-t-4`} />
      <View className={`${bracket} right-0 top-0 rounded-tr-3xl border-r-4 border-t-4`} />
      <View className={`${bracket} bottom-0 left-0 rounded-bl-3xl border-b-4 border-l-4`} />
      <View className={`${bracket} bottom-0 right-0 rounded-br-3xl border-b-4 border-r-4`} />

      {/*
        Suppressed while busy. The two say different things about the same
        moment — "that is not a HostelPalika ID card" under "Fetching their
        details" is a screen contradicting itself — and the overlay is the one
        describing what is happening now.
      */}
      {message && !busy ? (
        <View className="absolute inset-x-0 -bottom-12 items-center">
          <View className="rounded-full bg-black/70 px-4 py-2">
            <Text className="text-center text-xs font-medium text-white">{message}</Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}
