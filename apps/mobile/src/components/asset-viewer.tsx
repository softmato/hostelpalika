import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  ScrollView,
  useWindowDimensions,
  View,
} from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { isPdfReceipt, PdfPreview, readRemotePdf } from "@/components/receipt-preview";
import { Text } from "@/components/ui/text";
import { useAppSelector } from "@/hooks/redux";
import { useSystemInsets } from "@/hooks/use-system-insets";
import { API_BASE_URL } from "@/lib/api";
import {
  closeAssetViewer,
  getAssetViewerState,
  isPreviewable,
  setAssetViewerIndex,
  subscribeToAssetViewer,
  type ViewerItem,
  viewerFileName,
  viewerSourceFor,
} from "@/lib/asset-viewer";
import { downloadAndShareImage } from "@/lib/documents";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * The app's one asset viewer, mounted once at the root.
 *
 * Any screen opens it with `openAssetViewer(items, index)` — see
 * `lib/asset-viewer.ts` for why it is a plain module store. The screens that had
 * their own (a complaint attachment in a bottom sheet at a fixed 360dp, with
 * no zoom) now hand their gallery over instead.
 *
 * ## Why a `Modal` rather than an absolutely positioned view
 *
 * Two things come free and are both load-bearing: the Android hardware back
 * button (`onRequestClose`), and drawing above the absolutely-positioned tab bar
 * and the SOS button without either of them needing to know this exists.
 *
 * `GestureHandlerRootView` is repeated inside it because a React Native `Modal`
 * is a separate native view hierarchy — gestures registered in the app's root
 * one do not reach into it, and the symptom is pinch-to-zoom silently doing
 * nothing on Android.
 *
 * ## It is black, not themed
 *
 * The one surface in the app that ignores the theme. A photo is judged against
 * what surrounds it, and a white frame in light mode changes how the image
 * itself reads — every photo viewer on both platforms is dark for this reason.
 */

/** Past this, releasing a downward drag closes the viewer. */
const DISMISS_DISTANCE = 130;

/** Zoom bounds. Below 1 the image would float in the frame; above 5 is mush. */
const MIN_SCALE = 1;
const MAX_SCALE = 5;

/** The bottom strip's cell: thumb + 2dp border each side + gap. */
const STRIP_THUMB = 40;
const STRIP_GAP = 6;
const STRIP_PAD = 16;
const STRIP_STEP = STRIP_THUMB + 6 + STRIP_GAP;

/*
 * One id per *open*, keyed on the items array's identity. `openAssetViewer`
 * builds a new array each time; `setAssetViewerIndex` spreads the state and keeps
 * the same one — so a swipe keeps the id and the body stays mounted.
 */
const openIds = new WeakMap<readonly ViewerItem[], number>();
let lastOpenId = 0;

function openIdFor(items: readonly ViewerItem[]) {
  let id = openIds.get(items);

  if (id === undefined) {
    id = ++lastOpenId;
    openIds.set(items, id);
  }

  return id;
}

function useViewerState() {
  return useSyncExternalStore(
    subscribeToAssetViewer,
    getAssetViewerState,
    getAssetViewerState,
  );
}

export function AssetViewer() {
  const state = useViewerState();

  return (
    <Modal
      animationType="fade"
      onRequestClose={closeAssetViewer}
      statusBarTranslucent
      transparent
      visible={state !== null}
    >
      {/*
        Keyed per open, so each open remounts the body and lands on its page.
        It used to be keyed on `state.index` — which every swipe writes back to
        the store — so each swipe remounted every page and the photo that had
        just appeared flashed back through its loading state.
      */}
      {state ? (
        <ViewerBody
          initialIndex={state.index}
          items={state.items}
          key={openIdFor(state.items)}
        />
      ) : null}
    </Modal>
  );
}

function ViewerBody({
  initialIndex,
  items,
}: {
  initialIndex: number;
  items: readonly ViewerItem[];
}) {
  const { height, width } = useWindowDimensions();
  const insets = useSystemInsets();
  const token = useAppSelector((state) => state.auth.accessToken);
  const scrollRef = useRef<ScrollView>(null);
  const stripRef = useRef<ScrollView>(null);

  // Read once: the prop follows the store's index, which swipes keep writing.
  const [startIndex] = useState(initialIndex);
  const [index, setIndex] = useState(initialIndex);
  const [zoomed, setZoomed] = useState(false);
  const [saving, setSaving] = useState(false);

  /*
   * Drives the drag-to-dismiss fade. The backdrop thins as the image is pulled
   * away, which is what makes the gesture legible — without it the image simply
   * slides off a wall and the user cannot tell whether letting go will close it.
   */
  const dismissProgress = useSharedValue(0);

  /*
   * Drag down to dismiss — the gesture every photo viewer on both platforms has,
   * and the one people try before they look for a close button.
   *
   * It lives on the pager rather than inside each page because the shared value
   * it writes belongs to this component. Two further constraints come from the
   * React Compiler, which cannot tell a `SharedValue` from an ordinary object
   * and therefore only accepts writes it can attribute to the component that
   * created the value:
   *
   * 1. **Named worklets, not inline arrows** — the same shape
   *    `BottomChromeProvider` uses. An arrow buried in a builder chain is not a
   *    write the compiler can attribute, and lints as mutating something
   *    immutable.
   * 2. **Every write is declared before the first `useAnimatedStyle` that reads
   *    it.** Passing a value to a hook freezes it, so the styles below come
   *    *after* these functions. Moving them back up is the same lint error in a
   *    less obvious costume.
   */
  function onDismissUpdate(event: { translationY: number }) {
    "worklet";

    // Downward only: following an upward drag would let the photo be flung off
    // the top of the screen with nothing to bring it back.
    dismissProgress.value = Math.max(event.translationY, 0);
  }

  function onDismissEnd(event: { translationY: number; velocityY: number }) {
    "worklet";

    // Distance *or* velocity: a quick flick down is the same intent as a slow
    // long drag, and requiring the distance from a flick feels stuck.
    if (event.translationY > DISMISS_DISTANCE || event.velocityY > 900) {
      runOnJS(closeAssetViewer)();

      return;
    }

    dismissProgress.value = withTiming(0);
  }

  const dismissDrag = Gesture.Pan()
    .activeOffsetY([-18, 18])
    .enabled(!zoomed)
    .failOffsetX([-12, 12])
    .onUpdate(onDismissUpdate)
    .onEnd(onDismissEnd);

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: 1 - Math.min(dismissProgress.value / DISMISS_DISTANCE, 1) * 0.75,
  }));

  const chromeStyle = useAnimatedStyle(() => ({
    opacity: dismissProgress.value > 8 ? 0 : 1,
  }));

  const pagerStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: dismissProgress.value }],
  }));

  useEffect(() => {
    if (startIndex > 0) {
      // Without `animated: false` the viewer opens on the first image and then
      // visibly races to the tapped one.
      scrollRef.current?.scrollTo({ animated: false, x: startIndex * width });
    }
  }, [startIndex, width]);

  // Keeps the active thumbnail centred in the strip as the pager moves.
  useEffect(() => {
    stripRef.current?.scrollTo({
      animated: true,
      x: Math.max(0, STRIP_PAD + index * STRIP_STEP - (width - STRIP_STEP) / 2),
    });
  }, [index, width]);

  /** Strip tap: jump the pager. Programmatic scrolls fire no momentum end, so set the index here. */
  const goTo = useCallback(
    (next: number) => {
      scrollRef.current?.scrollTo({ animated: true, x: next * width });
      setIndex(next);
      setAssetViewerIndex(next);
    },
    [width],
  );

  const onMomentumEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const next = Math.round(event.nativeEvent.contentOffset.x / width);

      setIndex(next);
      // Mirrored into the store so a caller can read which item was last seen —
      // and so re-opening lands where the user left off.
      setAssetViewerIndex(next);
    },
    [width],
  );

  const current = items[index];

  const save = useCallback(async () => {
    if (!current) {
      return;
    }

    const source = viewerSourceFor(current, { baseUrl: API_BASE_URL, token });

    if (!source) {
      return;
    }

    setSaving(true);

    try {
      await downloadAndShareImage({
        // Only our own authorising route gets the token; a public URL that
        // receives one is rejected by R2 outright.
        authorize: Boolean(source.headers),
        fileName: viewerFileName(current, index),
        mimeType: current.mimeType ?? "image/jpeg",
        url: source.uri,
      });
      toastSuccess("Ready to save", "Pick “Save image” in the share sheet.");
    } catch (caught) {
      toastError(
        "Could not save that",
        caught instanceof Error ? caught.message : undefined,
      );
    } finally {
      setSaving(false);
    }
  }, [current, index, token]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Animated.View className="flex-1 bg-black" style={backdropStyle} />

      <GestureDetector gesture={dismissDrag}>
        <Animated.View className="absolute inset-0" style={pagerStyle}>
          <ScrollView
            horizontal
            onMomentumScrollEnd={onMomentumEnd}
            pagingEnabled
            ref={scrollRef}
            // Paging has to yield while an image is zoomed in, or panning around
            // a magnified photo flicks to the next one instead.
            scrollEnabled={!zoomed && items.length > 1}
            showsHorizontalScrollIndicator={false}
          >
            {items.map((item, itemIndex) => (
              <ViewerPage
                height={height}
                item={item}
                key={`${item.assetId ?? item.url}-${itemIndex}`}
                onZoomChange={setZoomed}
                token={token}
                width={width}
              />
            ))}
          </ScrollView>
        </Animated.View>
      </GestureDetector>

      {/* Chrome fades out while the image is being dragged away, so the gesture
          is not competing with a close button for attention. */}
      <Animated.View
        className="absolute inset-x-0 top-0 flex-row items-center gap-3 px-4 pb-3"
        style={[{ paddingTop: insets.top + 8, pointerEvents: "box-none" }, chromeStyle]}
      >
        <Pressable
          accessibilityLabel="Close"
          accessibilityRole="button"
          className="h-10 w-10 items-center justify-center rounded-full bg-black/50 active:opacity-70"
          hitSlop={8}
          onPress={closeAssetViewer}
        >
          <Ionicons color="#ffffff" name="close" size={22} />
        </Pressable>

        <View className="flex-1">
          {items.length > 1 ? (
            <Text className="text-center text-sm font-medium text-white">
              {index + 1} of {items.length}
            </Text>
          ) : null}
        </View>

        <Pressable
          accessibilityLabel="Save or share"
          accessibilityRole="button"
          className="h-10 w-10 items-center justify-center rounded-full bg-black/50 active:opacity-70"
          disabled={saving}
          hitSlop={8}
          onPress={() => void save()}
        >
          {saving ? (
            <ActivityIndicator color="#ffffff" size="small" />
          ) : (
            <Ionicons color="#ffffff" name="share-outline" size={20} />
          )}
        </Pressable>
      </Animated.View>

      {current?.caption || current?.title || items.length > 1 ? (
        <Animated.View
          className="absolute inset-x-0 bottom-0 gap-3 bg-black/40 pt-3"
          style={[
            { paddingBottom: insets.bottom + 14, pointerEvents: "box-none" },
            chromeStyle,
          ]}
        >
          {current?.caption || current?.title ? (
            <View className="gap-1 px-5" style={{ pointerEvents: "none" }}>
              {current.title ? (
                <Text className="text-base font-medium text-white">{current.title}</Text>
              ) : null}
              {current.caption ? (
                <Text className="text-sm text-white/70">{current.caption}</Text>
              ) : null}
            </View>
          ) : null}

          {/* The group at a glance — tap any thumbnail to jump straight to it. */}
          {items.length > 1 ? (
            <ScrollView
              // Centred when the group fits the width; scrolls from the left when it does not.
              contentContainerStyle={{
                flexGrow: 1,
                gap: STRIP_GAP,
                justifyContent: "center",
                paddingHorizontal: STRIP_PAD,
              }}
              horizontal
              ref={stripRef}
              showsHorizontalScrollIndicator={false}
            >
              {items.map((item, itemIndex) => (
                <StripThumb
                  active={itemIndex === index}
                  item={item}
                  key={`${item.assetId ?? item.url}-${itemIndex}`}
                  label={`Show ${itemIndex + 1} of ${items.length}`}
                  onPress={() => goTo(itemIndex)}
                  token={token}
                />
              ))}
            </ScrollView>
          ) : null}
        </Animated.View>
      ) : null}
    </GestureHandlerRootView>
  );
}

function StripThumb({
  active,
  item,
  label,
  onPress,
  token,
}: {
  active: boolean;
  item: ViewerItem;
  label: string;
  onPress: () => void;
  token: string | null | undefined;
}) {
  const source = isPreviewable(item)
    ? viewerSourceFor(item, { baseUrl: API_BASE_URL, token })
    : null;
  const cell = {
    backgroundColor: "rgba(255,255,255,0.12)",
    borderRadius: 6,
    height: STRIP_THUMB,
    width: STRIP_THUMB,
  } as const;

  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="imagebutton"
      accessibilityState={{ selected: active }}
      hitSlop={4}
      onPress={onPress}
      style={{
        borderColor: active ? "#ffffff" : "transparent",
        borderRadius: 9,
        borderWidth: 2,
        opacity: active ? 1 : 0.55,
        padding: 1,
      }}
    >
      {source ? (
        <Image contentFit="cover" source={source} style={cell} />
      ) : (
        <View className="items-center justify-center" style={cell}>
          <Ionicons color="#ffffff" name="document-outline" size={16} />
        </View>
      )}
    </Pressable>
  );
}

function ViewerPage({
  height,
  item,
  onZoomChange,
  token,
  width,
}: {
  height: number;
  item: ViewerItem;
  onZoomChange: (zoomed: boolean) => void;
  token: string | null | undefined;
  width: number;
}) {
  const [status, setStatus] = useState<"failed" | "loaded" | "loading">("loading");
  /*
   * The zoom state is mirrored into React state as well as the shared value:
   * `Gesture.enabled()` is evaluated on the JS thread when the gesture is built,
   * so it cannot read a shared value, and both this page's pan and the pager's
   * dismiss drag are gated on it.
   */
  const [zoomedIn, setZoomedIn] = useState(false);
  const source = viewerSourceFor(item, { baseUrl: API_BASE_URL, token });

  const reportZoom = (next: boolean) => {
    setZoomedIn(next);
    onZoomChange(next);
  };

  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const offsetX = useSharedValue(0);
  const offsetY = useSharedValue(0);
  const savedX = useSharedValue(0);
  const savedY = useSharedValue(0);

  const reset = () => {
    "worklet";
    scale.value = withTiming(1);
    savedScale.value = 1;
    offsetX.value = withTiming(0);
    offsetY.value = withTiming(0);
    savedX.value = 0;
    savedY.value = 0;
    runOnJS(reportZoom)(false);
  };

  const pinch = Gesture.Pinch()
    .onUpdate((event) => {
      scale.value = Math.min(
        Math.max(savedScale.value * event.scale, MIN_SCALE),
        MAX_SCALE,
      );
    })
    .onEnd(() => {
      if (scale.value <= MIN_SCALE) {
        reset();

        return;
      }

      savedScale.value = scale.value;
      runOnJS(reportZoom)(true);
    });

  /*
   * Moves a magnified image inside the frame. Enabled only while zoomed, so at
   * rest the pager's dismiss drag gets the gesture rather than the two competing
   * to activate on the same pixels.
   */
  const pan = Gesture.Pan()
    .enabled(zoomedIn)
    .onUpdate((event) => {
      offsetX.value = savedX.value + event.translationX;
      offsetY.value = savedY.value + event.translationY;
    })
    .onEnd(() => {
      savedX.value = offsetX.value;
      savedY.value = offsetY.value;
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      if (scale.value > MIN_SCALE) {
        reset();

        return;
      }

      scale.value = withTiming(2.5);
      savedScale.value = 2.5;
      runOnJS(reportZoom)(true);
    });

  const gesture = Gesture.Simultaneous(Gesture.Exclusive(doubleTap, pan), pinch);

  const imageStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: offsetX.value },
      { translateY: offsetY.value },
      { scale: scale.value },
    ],
  }));

  // A PDF is drawn page by page with pdf.js rather than handed to Save.
  if (source && isPdfReceipt(item.mimeType)) {
    return (
      <View style={{ height, width }}>
        <PdfPreview allPages height={height} label={item.title ?? "Document"} read={() => readRemotePdf(item)} />
      </View>
    );
  }

  if (!source || !isPreviewable(item)) {
    return (
      <View className="items-center justify-center gap-2 px-8" style={{ height, width }}>
        <Ionicons color="#ffffff" name="document-outline" size={40} />
        <Text className="text-center text-sm text-white/70">
          {isPreviewable(item)
            ? "This file could not be found."
            : "This file cannot be previewed here. Use Save to open it."}
        </Text>
      </View>
    );
  }

  return (
    <GestureDetector gesture={gesture}>
      <View className="items-center justify-center" style={{ height, width }}>
        {status === "loading" ? (
          <ActivityIndicator className="absolute" color="#ffffff" size="large" />
        ) : null}

        {status === "failed" ? (
          <View className="absolute items-center gap-2 px-8">
            <Ionicons color="#ffffff" name="image-outline" size={40} />
            <Text className="text-center text-sm text-white/70">
              That image could not be loaded.
            </Text>
          </View>
        ) : null}

        <Animated.View style={imageStyle}>
          <Image
            // `contain`, so the whole asset is visible at rest whatever its
            // aspect ratio — a receipt photographed in portrait must not open
            // cropped to its middle third.
            contentFit="contain"
            onError={() => setStatus("failed")}
            onLoad={() => setStatus("loaded")}
            source={source}
            style={{ height, width }}
            transition={120}
          />
        </Animated.View>
      </View>
    </GestureDetector>
  );
}
