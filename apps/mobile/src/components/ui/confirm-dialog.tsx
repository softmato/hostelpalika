import { BlurView } from "expo-blur";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  ActivityIndicator,
  BackHandler,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { PinPad } from "@/components/ui/pin-pad";
import { pressHaptic } from "@/components/ui/pressable-scale";
import { Text } from "@/components/ui/text";
import { useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { readApiError } from "@/lib/api-contract";
import { checkLockPin } from "@/lib/app-lock";
import {
  closeConfirm,
  type ConfirmRequest,
  getConfirmRequest,
  subscribeToConfirm,
} from "@/lib/confirm";

/**
 * The centred iOS-style alert for "are you sure?", with the wait shown *in* the
 * button that caused it, over a blurred screen.
 *
 * **This is the app's custom alert.** Anything that would otherwise reach for
 * `Alert.alert` to ask a question comes here instead — from anywhere, without
 * wiring any state, by calling `openConfirm()` from `lib/confirm`.
 *
 * ## Why this exists next to `<Sheet>`
 *
 * `Sheet`'s doc comment says it is the surface every "confirm this" uses, and
 * for a question that is part of a flow — pick a month, then apply — that is
 * still right: a sheet sits over the screen you came from and can be dragged
 * away. This is the other case. Destroying something the owner cannot get back
 * is not part of a flow; it is an interruption, and an interruption belongs in
 * the middle of the screen where a stray thumb is nowhere near it.
 *
 * ## Why not `Alert.alert`
 *
 * The native alert cannot show progress. Every destructive action here goes to
 * the server, so the moment "Remove" is pressed the alert closes and the screen
 * behind it looks untouched until the request lands and a toast arrives — which
 * on a slow hostel connection is a second or more of the owner believing the tap
 * missed. They press the cross again, on a photograph that is already being
 * deleted. Keeping the dialog up and turning its confirm button into a spinner
 * makes the wait belong to the thing that is waiting, and it is what stops the
 * second press: the button is disabled for as long as it is busy.
 *
 * The native alert also looks like whatever OS it is on, and on Android that is
 * a left-aligned Material dialog — the one place in this app where the platform
 * would decide the design instead of `docs/DESIGN.md`.
 *
 * ## The shape is the iOS alert, deliberately
 *
 * 270 points wide, 14-point corners, a centred title over smaller message text,
 * and the actions as a hairline-divided row rather than as two stacked buttons.
 * The palette rule still holds: the frosting is the theme's own card colour, the
 * confirm is `--destructive`, and the preferred action is the brand green.
 *
 * ## Why it is not a `<Modal>`
 *
 * An Android `Modal` is a separate window, and opening one costs a window
 * transition the dialog does not need. It draws as an absolute-fill overlay at
 * the app root instead: the Android back button is handled with `BackHandler`,
 * and covering the tab bar comes from being mounted at the root rather than
 * inside a navigator.
 *
 * ## No backdrop blur
 *
 * There was one. On Android it re-captured the whole app every frame it
 * animated, so the card arrived late and left a ghost behind on the way out
 * (field video, 2026-10-28). The scrim alone carries the contrast.
 */

/** The iOS alert's width in points. Fixed, not a fraction of the screen. */
const CARD_WIDTH = 270;
/** Room for the four PIN boxes and the keypad. */
const CARD_WIDTH_PIN = 316;

/** Each action row. 44 is the platform's own minimum tap target. */
const ACTION_HEIGHT = 44;

/**
 * In fast, out faster: one eased fade for scrim and card together, and the card
 * settling up from just under full size. Short enough to read as instant.
 */
const OPEN_MS = 140;
const CLOSE_MS = 100;
const START_SCALE = 0.96;

export type ConfirmDialogProps = ConfirmRequest & {
  /**
   * Fires for the cancel action, for a tap on the backdrop, for Android's back
   * button, and again once {@link ConfirmRequest.onConfirm} has settled — so a
   * caller closes the dialog in exactly one place regardless of how it ended.
   */
  onClose: () => void;
  open: boolean;
};

/**
 * The controlled form, for a screen that would rather hold the boolean itself.
 * Most callers want `openConfirm()` instead — it needs no state at all.
 */
export function ConfirmDialog({
  cancelLabel = "Cancel",
  confirmLabel,
  destructive = false,
  message,
  onCancel,
  onClose,
  onConfirm,
  open,
  pin = false,
  title,
}: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);
  const [pinValue, setPinValue] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);

  /*
   * The confirm handler outlives the card it was pressed on: the work is awaited
   * here, and the caller's `onClose` may unmount this component as soon as it
   * runs. Without the guard the `finally` below sets state on a dialog that no
   * longer exists.
   */
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;

    return () => {
      alive.current = false;
    };
  }, []);

  /*
   * `pending` is state, so a second tap in the same frame still reads `false`
   * and runs the work twice — for a synchronous `router.back()` that is two
   * GO_BACKs, and the second has no screen to land on. The ref flips at once.
   */
  const running = useRef(false);

  const confirm = useCallback((typed?: string) => {
    if (pending) {
      return;
    }

    if (running.current) {
      return;
    }

    const entered = typed ?? pinValue;

    if (pin && entered.length !== 4) {
      return;
    }

    running.current = true;
    setPending(true);
    // The one press in the app that always commits something serious.
    pressHaptic("light");

    void (async () => {
      // A wrong PIN keeps the card up, cleared, for another try.
      if (pin) {
        try {
          await checkLockPin(entered);
        } catch (caught) {
          if (alive.current) {
            running.current = false;
            setPending(false);
            setPinValue("");
            setPinError(readApiError(caught, "That PIN did not work."));
          }
          return;
        }
      }

      try {
        await onConfirm();
      } finally {
        /*
         * Cleared here rather than from an `open` effect: `confirm` is the only
         * thing that ever sets it, and while it is set neither the cancel, the
         * backdrop nor the back button can close the card — so this is the one
         * path that has to put the button back.
         */
        if (alive.current) {
          running.current = false;
          setPending(false);
        }

        onClose();
      }
    })();
  }, [onClose, onConfirm, pending, pin, pinValue]);

  const dismiss = useCallback(() => {
    // A request is already out. Closing the card here would leave the owner with
    // no sign that the thing they asked for is still happening.
    if (pending) {
      return;
    }

    onClose();
  }, [onClose, pending]);

  const cancel = useCallback(() => {
    if (pending) {
      return;
    }

    onClose();
    onCancel?.();
  }, [onCancel, onClose, pending]);

  /*
   * A one-button alert has no "walk away" answer. A stray tap on the frost
   * would otherwise close it and leave the reader on a screen the alert was
   * there to say they cannot use; Android's back button is the one gesture
   * that plainly means the action, so it runs it.
   */
  const single = cancelLabel === null;

  /*
   * The card is its own component so that its animation values are created
   * fresh on every open. Held up here they would survive the close, and the
   * next question would arrive already settled with no pop at all.
   */
  return open ? (
    <ConfirmCard
      cancelLabel={cancelLabel}
      confirmLabel={confirmLabel}
      destructive={destructive}
      message={message}
      onBackdrop={single ? undefined : dismiss}
      onCancel={cancel}
      onConfirm={() => confirm()}
      onHardwareBack={single ? () => confirm() : dismiss}
      pending={pending}
      pinPad={
        pin ? (
          <PinPad
            busy={pending}
            error={pinError}
            onChange={(value) => {
              setPinError(null);
              setPinValue(value);
            }}
            onComplete={confirm}
            value={pinValue}
          />
        ) : null
      }
      ready={!pin || pinValue.length === 4}
      title={title}
    />
  ) : null;
}

function ConfirmCard({
  cancelLabel,
  confirmLabel,
  destructive,
  message,
  onBackdrop,
  onCancel,
  onConfirm,
  onHardwareBack,
  pending,
  pinPad,
  ready,
  title,
}: {
  /** `null` draws the confirm alone, full width. */
  cancelLabel: string | null;
  confirmLabel: string;
  destructive: boolean;
  message?: string;
  /** Absent for an alert the backdrop must not close. */
  onBackdrop?: () => void;
  onCancel: () => void;
  onConfirm: () => void;
  onHardwareBack: () => void;
  pending: boolean;
  /** The PIN step, when the question asks for one; the card widens to hold it. */
  pinPad: ReactNode;
  /** False until a PIN step has its four digits. */
  ready: boolean;
  title: string;
}) {
  const { colors, isDark } = useAppTheme();

  const scale = useSharedValue(START_SCALE);

  useEffect(() => {
    scale.value = withTiming(1, { duration: OPEN_MS, easing: Easing.out(Easing.cubic) });
  }, [scale]);

  const cardStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  /*
   * Without a `Modal` there is nothing between a back press and the screen
   * underneath, so back would navigate away and leave the question sitting on
   * top of wherever it landed. Returning `true` swallows it; while a request is
   * out both handlers are no-ops, so back is inert exactly when the buttons are.
   */
  useEffect(() => {
    const subscription = BackHandler.addEventListener(
      "hardwareBackPress",
      () => {
        onHardwareBack();

        return true;
      },
    );

    return () => subscription.remove();
  }, [onHardwareBack]);

  return (
    <Animated.View
      entering={FadeIn.duration(OPEN_MS).easing(Easing.out(Easing.cubic))}
      exiting={FadeOut.duration(CLOSE_MS).easing(Easing.in(Easing.cubic))}
      style={StyleSheet.absoluteFill}
    >
      {/* The backdrop is a target too: tapping outside an alert cancels it —
          unless it is a one-button alert, which has nothing to cancel to. */}
      <Pressable
        accessibilityLabel={cancelLabel ?? undefined}
        accessibilityRole={onBackdrop ? "button" : undefined}
        accessible={Boolean(onBackdrop)}
        className="flex-1 items-center justify-center px-8"
        onPress={onBackdrop}
      >
        <View
          className={isDark ? "bg-black/55" : "bg-black/35"}
          style={StyleSheet.absoluteFill}
        />

        {/*
          An `onPress` with an empty body rather than `pointerEvents`: this is
          what stops a tap on the card itself from reaching the backdrop and
          cancelling the question the owner is still reading.
        */}
        <Pressable accessible={false} onPress={() => {}}>
          <Animated.View
            accessibilityViewIsModal
            className="overflow-hidden"
            style={[
              cardStyle,
              {
                /*
                 * The border and the lift are what separate a near-white card
                 * from a near-white frost. In dark mode they do the same job in
                 * the other direction.
                 */
                borderColor: colors.border,
                borderRadius: 14,
                borderWidth: StyleSheet.hairlineWidth,
                elevation: 12,
                shadowColor: "#000000",
                shadowOffset: { height: 8, width: 0 },
                shadowOpacity: isDark ? 0.5 : 0.18,
                shadowRadius: 24,
                width: pinPad ? CARD_WIDTH_PIN : CARD_WIDTH,
              },
            ]}
          >
            <BlurView intensity={40} tint={isDark ? "dark" : "light"}>
              {/*
                Alpha on the card token, so the blur has something to show
                through on iOS while Android still gets a ground solid enough to
                read 13pt type on. `F2` is 95%.
              */}
              <View style={{ backgroundColor: `${colors.card}F2` }}>
                <View className="items-center gap-1 px-4 pb-4 pt-5">
                  <Text
                    className="text-center text-[17px] font-semibold text-foreground"
                    style={{ lineHeight: 22 }}
                    variant={null}
                  >
                    {title}
                  </Text>

                  {message ? (
                    <Text
                      className="text-center text-[13px] text-foreground"
                      style={{ lineHeight: 18 }}
                      variant={null}
                    >
                      {message}
                    </Text>
                  ) : null}
                </View>

                {pinPad ? <View className="px-3 pb-2">{pinPad}</View> : null}

                <View
                  style={{
                    backgroundColor: colors.border,
                    height: StyleSheet.hairlineWidth,
                  }}
                />

                <View className="flex-row" style={{ height: ACTION_HEIGHT }}>
                  {cancelLabel === null ? null : (
                    <>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ disabled: pending }}
                        className="flex-1 items-center justify-center active:opacity-50"
                        disabled={pending}
                        onPress={onCancel}
                      >
                        {/*
                          The bold one is the *preferred* action, which for a
                          destructive question is the one that changes nothing.
                        */}
                        <Text
                          className="text-[17px] font-semibold"
                          style={{
                            color: pending
                              ? colors.mutedForeground
                              : colors.primary,
                          }}
                          variant={null}
                        >
                          {cancelLabel}
                        </Text>
                      </Pressable>

                      <View
                        style={{
                          backgroundColor: colors.border,
                          width: StyleSheet.hairlineWidth,
                        }}
                      />
                    </>
                  )}

                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ busy: pending, disabled: pending || !ready }}
                    className={`flex-1 items-center justify-center active:opacity-50 ${ready ? "" : "opacity-40"}`}
                    disabled={pending || !ready}
                    onPress={onConfirm}
                  >
                    {pending ? (
                      /*
                        The spinner replaces the label rather than sitting beside
                        it: the row is 44 points tall and about 135 wide, so a
                        word plus a spinner wraps. Losing the word costs nothing
                        — the title above still says what is being removed.
                      */
                      <ActivityIndicator
                        color={destructive ? colors.destructive : colors.primary}
                        size="small"
                      />
                    ) : (
                      <Text
                        // Alone, it is the preferred action by definition.
                        className={
                          cancelLabel === null
                            ? "text-[17px] font-semibold"
                            : "text-[17px]"
                        }
                        style={{
                          color: destructive
                            ? colors.destructive
                            : colors.primary,
                        }}
                        variant={null}
                      >
                        {confirmLabel}
                      </Text>
                    )}
                  </Pressable>
                </View>
              </View>
            </BlurView>
          </Animated.View>
        </Pressable>
      </Pressable>
    </Animated.View>
  );
}

/**
 * The one dialog `openConfirm()` drives. Mounted once, at the app root.
 *
 * Same reasoning as `<AssetViewer />`: any screen can ask a question, and a
 * per-screen copy is how you end up with the blur on one and not on the next. It
 * renders nothing at all until a question is asked, so the blur costs nothing
 * while it is idle.
 */
export function ConfirmDialogHost() {
  const request = useSyncExternalStore(
    subscribeToConfirm,
    getConfirmRequest,
    getConfirmRequest,
  );
  // Only an account that has a PIN can be asked for one; a temporary login never.
  const hasPin = useAppSelector(
    (state) => state.auth.account?.hasLockPin === true && !state.auth.account.viaTemporaryCredential,
  );

  if (!request) {
    return null;
  }

  return (
    <ConfirmDialog
      {...request}
      /*
       * Keyed on the request, so two questions asked in a row cannot share a
       * card: without it the second would inherit the first's `pending` and
       * open with a spinner where its confirm button should be.
       */
      key={request.id}
      onClose={closeConfirm}
      open
      pin={Boolean(request.pin) && hasPin}
    />
  );
}
