import { BlurView } from "expo-blur";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ActivityIndicator,
  BackHandler,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import Animated, {
  FadeIn,
  FadeOut,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from "react-native-reanimated";

import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { appBlurTarget } from "@/lib/blur-target";
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
 * ## Why it is not a `<Modal>`, and why the blur is the reason
 *
 * An Android `Modal` is a **separate window**. `BlurView` blurs what is behind
 * it *in its own window*, so a blurred backdrop inside a modal has nothing to
 * blur — the app the owner is looking at is in the window underneath. The
 * frosted screen this dialog is supposed to sit on would simply not appear
 * there, and only on Android, which is the worst kind of difference to ship.
 *
 * So it draws as an absolute-fill overlay at the app root instead, in the same
 * window as everything it covers. That costs the two things a modal gave for
 * free, and both are paid back below: the Android back button is handled with
 * `BackHandler`, and covering the tab bar comes from being mounted at the root
 * rather than inside a navigator.
 *
 * ## `blurMethod`, which `GlassPanel` refuses
 *
 * That component's note is about the hero on the first screen the app opens:
 * Android's blur works by redrawing the target view into an offscreen buffer
 * every frame, and paying that forever for decoration nobody asked for is not a
 * trade. This one is a dialog. It is on screen while a question is being
 * answered and gone a second later, the frost *is* the point — the screen behind
 * has to read as pushed out of reach — and the scrim underneath still carries
 * the contrast, so a device that renders no blur at all gets a legible dialog
 * rather than a broken one.
 *
 * The prop is `blurMethod`; `experimentalBlurMethod` is the deprecated spelling
 * and warns on sight. On its own it still does nothing — Android also needs
 * `blurTarget`, which is the whole point of `lib/blur-target.ts`.
 */

/** The iOS alert's width in points. Fixed, not a fraction of the screen. */
const CARD_WIDTH = 270;

/** Each action row. 44 is the platform's own minimum tap target. */
const ACTION_HEIGHT = 44;

/**
 * The scale the card animates in *from*. Just over 1, so it settles inward the
 * way the native alert does rather than growing out of nothing. There is no
 * matching scale on the way out: iOS fades its alert away, it does not shrink it.
 */
const OVERSHOOT = 1.12;

/**
 * How far the frost is allowed to go, per theme, before
 * {@link BLUR_REDUCTION} divides it on Android.
 *
 * Deliberately light. The job is to push the screen behind out of focus so the
 * card is the only thing to read, not to erase it — at full strength the app
 * underneath becomes an anonymous smear, and the owner loses the context they
 * were asking the question *about*. The dark theme carries a little more
 * because its scrim is doing more of the work already.
 */
const BLUR_LIGHT = 42;
const BLUR_DARK = 48;

/**
 * The divisor Android applies to `intensity`. It **divides** the radius, so a
 * smaller number is a heavier blur — halving it to 2 turned the screen behind
 * into an unreadable smear on the first device run. Left at the library's
 * default, which is the value tuned to match iOS at the same `intensity`.
 */
const BLUR_REDUCTION = 4;

/**
 * The frost arrives *after* the card, not with it.
 *
 * Everything fading up together reads as one flat layer being swapped in, and
 * the screen behind — which is the thing the owner was just looking at — appears
 * to have been replaced rather than pushed back. Letting the card land first and
 * then pulling focus off the screen underneath is the order the eye can follow,
 * and it is what the native iOS alert does with its own backdrop material.
 *
 * The delay is roughly the card's own fade, so the two never overlap.
 */
const BLUR_DELAY_MS = 130;
const BLUR_DURATION_MS = 340;

/**
 * `expo-blur` supports `intensity` as an animated prop, which is the only way to
 * ramp the blur: it is a native property, not a style, so `useAnimatedStyle`
 * cannot reach it and animating opacity instead would fade the *whole* frosted
 * layer in — the flat-swap reading again, one level down.
 */
const AnimatedBlurView = Animated.createAnimatedComponent(BlurView);

export type ConfirmDialogProps = ConfirmRequest & {
  /**
   * Fires for the cancel action, for a tap on the blurred backdrop, for
   * Android's back button, and again once {@link ConfirmRequest.onConfirm} has
   * settled — so a caller closes the dialog in exactly one place regardless of
   * how it ended.
   */
  onClose: () => void;
  open: boolean;
  /**
   * `false`: the scrim only, no blur. For a card drawn over the app lock — on
   * Android the frost is a capture of the whole app, which is the portal the
   * lock is there to hide.
   */
  frost?: boolean;
};

/**
 * The controlled form, for a screen that would rather hold the boolean itself.
 * Most callers want `openConfirm()` instead — it needs no state at all.
 */
export function ConfirmDialog({
  cancelLabel = "Cancel",
  confirmLabel,
  destructive = false,
  frost: frosted = true,
  message,
  onCancel,
  onClose,
  onConfirm,
  open,
  title,
}: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);

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

  const confirm = useCallback(() => {
    if (pending) {
      return;
    }

    if (running.current) {
      return;
    }

    running.current = true;
    setPending(true);

    void (async () => {
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
  }, [onClose, onConfirm, pending]);

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
      frosted={frosted}
      message={message}
      onBackdrop={single ? undefined : dismiss}
      onCancel={cancel}
      onConfirm={confirm}
      onHardwareBack={single ? confirm : dismiss}
      pending={pending}
      title={title}
    />
  ) : null;
}

function ConfirmCard({
  cancelLabel,
  confirmLabel,
  destructive,
  frosted,
  message,
  onBackdrop,
  onCancel,
  onConfirm,
  onHardwareBack,
  pending,
  title,
}: {
  /** `null` draws the confirm alone, full width. */
  cancelLabel: string | null;
  confirmLabel: string;
  destructive: boolean;
  frosted: boolean;
  message?: string;
  /** Absent for an alert the backdrop must not close. */
  onBackdrop?: () => void;
  onCancel: () => void;
  onConfirm: () => void;
  onHardwareBack: () => void;
  pending: boolean;
  title: string;
}) {
  const { colors, isDark } = useAppTheme();

  const scale = useSharedValue(OVERSHOOT);
  /** 0 = the screen as it was. Ramps to 1 once the card has landed. */
  const frost = useSharedValue(0);

  useEffect(() => {
    scale.value = withSpring(1, { damping: 18, stiffness: 320 });
    frost.value = withDelay(
      BLUR_DELAY_MS,
      withTiming(1, { duration: BLUR_DURATION_MS }),
    );
  }, [frost, scale]);

  const cardStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const blurProps = useAnimatedProps(() => ({
    intensity: frost.value * (isDark ? BLUR_DARK : BLUR_LIGHT),
  }));

  /* The scrim rides the same ramp — it is half of what the frost looks like. */
  const scrimStyle = useAnimatedStyle(() => ({
    opacity: frost.value,
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
      /*
       * Only the card is inside this fade in practice: the backdrop starts at
       * zero frost and ramps on its own clock, so what the owner sees is the
       * alert arriving on an untouched screen, and the screen going soft behind
       * it a beat later. On the way out both leave together — a dialog that
       * unfrosts before it disappears reads as a bug.
       */
      entering={FadeIn.duration(130)}
      exiting={FadeOut.duration(160)}
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
        {frosted ? (
          <AnimatedBlurView
            animatedProps={blurProps}
            /*
             * On Android the blur is a capture of a named view, not a sample of
             * whatever is behind this one — so `blurMethod` alone renders a flat
             * tint and logs that `blurTarget` was never configured. The target is
             * the whole app, wrapped once at the root; see `lib/blur-target.ts`.
             * iOS ignores both props and uses its own backdrop material.
             */
            blurMethod={Platform.OS === "android" ? "dimezisBlurView" : "none"}
            blurReductionFactor={BLUR_REDUCTION}
            blurTarget={appBlurTarget}
            // White frost in light mode, black in dark: the blur has to read as
            // the same screen pushed back, never as a colour laid over it.
            style={StyleSheet.absoluteFill}
            tint={isDark ? "dark" : "light"}
          />
        ) : null}
        {/*
          The blur alone is not contrast. It softens the screen behind without
          darkening it, so on a pale screen in light mode the card would sit on
          a ground of nearly its own colour — and on a device that renders no
          blur there would be nothing between them at all. The scrim is what
          makes the dialog the only legible thing on screen either way.
        */}
        <Animated.View
          className={isDark ? "bg-black/45" : "bg-black/20"}
          style={[StyleSheet.absoluteFill, scrimStyle]}
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
                width: CARD_WIDTH,
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
                    accessibilityState={{ busy: pending, disabled: pending }}
                    className="flex-1 items-center justify-center active:opacity-50"
                    disabled={pending}
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
    />
  );
}
