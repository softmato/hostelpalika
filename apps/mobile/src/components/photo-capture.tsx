import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Linking, Pressable, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Glyph, type GlyphName } from "@/components/ui/glyph";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { toastError } from "@/lib/toast";
import { APP_NAME } from "@/constants/branding";

/**
 * A live camera sitting in the page, with the shots taken so far under it.
 *
 * ## Why the camera is *running* rather than behind a button
 *
 * The screen this was built for is a resident reporting that something in the
 * hostel is wrong. They are already standing in front of it, phone in hand.
 * Every step between opening the screen and the picture existing — a tile that
 * says "Add photo", a system picker, a chooser between camera and gallery, a
 * confirm — is a step at which somebody decides it is not worth the bother, and
 * a complaint with no photograph is one an admin has to go and look at before
 * they can do anything about it.
 *
 * So the viewfinder is the page. Open the screen, point it, press the ring. The
 * whole interaction is one tap, and the reward — the thumbnail dropping into
 * the strip — is immediate.
 *
 * ## The gallery is still there, and it is not the headline
 *
 * Somebody photographed the broken window yesterday, or is raising the
 * complaint from their bed. The library button sits in the corner of the frame
 * rather than beside the shutter, because it is the second answer to the
 * question, not a peer of it.
 *
 * ## What it does not do
 *
 * It does not upload. The uris are local files and the caller decides when they
 * become assets — which for the complaint screen is on pick, so the bytes are
 * already in R2 by the time Send is pressed. Keeping that out of here is what
 * lets the same component serve a screen that wants to upload at the end.
 */

export type CapturedPhoto = {
  /** A local `file://` uri. Nothing here has been uploaded. */
  uri: string;
};

export function PhotoCapture({
  aspectRatio = 4 / 3,
  busy = false,
  className = "",
  max,
  onCapture,
  onPickFromLibrary,
  onRemove,
  photos,
}: {
  /**
   * Width over height of the viewfinder. `4/3` is a camera's own shape and the
   * default; a screen with room to spare passes something squarer or taller,
   * because a bigger frame is a steadier aim and a better photograph.
   */
  aspectRatio?: number;
  /** An upload is in flight — the shutter is inert while a picture is landing. */
  busy?: boolean;
  /** For a screen that wants the frame wider than its own gutter — `-mx-3`. */
  className?: string;
  max: number;
  onCapture: (photo: CapturedPhoto) => void;
  /** Opens the caller's own picker. Omit and the library button is not drawn. */
  onPickFromLibrary?: () => void;
  onRemove: (uri: string) => void;
  photos: CapturedPhoto[];
}) {
  const { colors } = useAppTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const camera = useRef<CameraView>(null);
  const [facing, setFacing] = useState<"back" | "front">("back");
  const [torch, setTorch] = useState(false);
  const [shooting, setShooting] = useState(false);

  /*
   * The preview is unmounted whenever the screen is not the one on top.
   *
   * Android holds the camera device for as long as the view exists, so a screen
   * left mounted underneath a pushed one keeps the hardware — and the next
   * screen that wants it (the ID scanner, another complaint) opens to a black
   * rectangle with no error anywhere. It also stops a viewfinder running in the
   * background eating a battery for a screen nobody is looking at.
   */
  const [focused, setFocused] = useState(false);

  useFocusEffect(
    useCallback(() => {
      setFocused(true);

      return () => {
        setFocused(false);
        setTorch(false);
      };
    }, []),
  );

  const full = photos.length >= max;

  const shoot = useCallback(async () => {
    if (!camera.current || shooting || full) {
      return;
    }

    setShooting(true);

    try {
      /*
       * `quality: 0.7` and no base64. A complaint photograph is looked at once,
       * on a phone or an admin's laptop, to answer "is this actually broken" —
       * and the person taking it is on a Nepali mobile connection paying for
       * every megabyte of it. `skipProcessing` is deliberately *not* set: it is
       * faster, but it also skips the rotation fix, and a picture of a leak
       * lying on its side is a picture somebody has to turn their head to read.
       */
      const picture = await camera.current.takePictureAsync({
        quality: 0.7,
        shutterSound: false,
      });

      if (!picture?.uri) {
        toastError("That did not take", "Try the shutter again.");
        return;
      }

      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      onCapture({ uri: picture.uri });
    } catch {
      toastError("The camera did not respond", "Try the shutter again.");
    } finally {
      setShooting(false);
    }
  }, [full, onCapture, shooting]);

  return (
    <View className="gap-3">
      {/*
        `className` lands on the frame, not on this container: a screen that
        pulls the viewfinder wider than the page gutter still wants the
        thumbnail strip lined up with everything else on the page.
      */}
      <View
        className={`overflow-hidden rounded-3xl border border-border ${className}`}
        style={{ backgroundColor: colors.muted }}
      >
        <View className="w-full" style={{ aspectRatio }}>
          {permission?.granted && focused ? (
            <CameraView
              enableTorch={torch}
              facing={facing}
              ref={camera}
              style={{ bottom: 0, left: 0, position: "absolute", right: 0, top: 0 }}
            />
          ) : null}

          {permission?.granted ? null : (
            <View className="flex-1 items-center justify-center gap-3 px-6">
              <Glyph
                color={colors.mutedForeground}
                name="camera"
                size={28}
              />
              <Text className="text-center" variant="caption">
                {permission?.canAskAgain === false
                  ? `Camera access is off for ${APP_NAME}. Turn it on in Settings, or attach a photo you already have.`
                  : "Show your hostel what is wrong. One tap, no typing."}
              </Text>
              <Button
                label={
                  permission?.canAskAgain === false ? "Open settings" : "Turn on camera"
                }
                onPress={
                  permission?.canAskAgain === false
                    ? () => void Linking.openSettings()
                    : () => void requestPermission()
                }
                size="sm"
                variant="secondary"
              />
            </View>
          )}

          {/*
            The controls float on the picture rather than sitting under it. A
            viewfinder with a toolbar below it is two objects; a viewfinder with
            its own controls on the glass is a camera, which is the thing every
            reference app in `app_recordings` builds when it puts a scanner on
            screen.
          */}
          {permission?.granted ? (
            <>
              <View className="absolute left-3 right-3 top-3 flex-row items-center justify-between">
                <View className="rounded-full bg-black/45 px-2.5 py-1">
                  <Text className="text-xs font-semibold text-white" variant={null}>
                    {photos.length} of {max}
                  </Text>
                </View>

                <View className="flex-row gap-2">
                  {facing === "back" ? (
                    <GlassButton
                      active={torch}
                      icon="flashlight"
                      label={torch ? "Turn off the light" : "Turn on the light"}
                      onPress={() => setTorch((current) => !current)}
                    />
                  ) : null}

                  <GlassButton
                    icon="camera-reverse"
                    label="Switch camera"
                    onPress={() => {
                      setTorch(false);
                      setFacing((current) => (current === "back" ? "front" : "back"));
                    }}
                  />
                </View>
              </View>

              <View className="absolute bottom-3 left-3 right-3 flex-row items-center justify-between">
                <View className="w-11">
                  {onPickFromLibrary && !full ? (
                    <GlassButton
                      icon="images"
                      label="Attach a photo you already have"
                      onPress={onPickFromLibrary}
                    />
                  ) : null}
                </View>

                <Shutter
                  busy={shooting || busy}
                  disabled={full}
                  onPress={() => void shoot()}
                />

                {/* Balances the shutter into the centre. */}
                <View className="w-11" />
              </View>

              {full ? (
                <View className="absolute bottom-16 left-0 right-0 items-center">
                  <View className="rounded-full bg-black/55 px-3 py-1.5">
                    <Text className="text-xs font-semibold text-white" variant={null}>
                      That is {max} photos — plenty
                    </Text>
                  </View>
                </View>
              ) : null}
            </>
          ) : null}
        </View>
      </View>

      {photos.length > 0 ? (
        <View className="flex-row flex-wrap gap-2">
          {photos.map((photo) => (
            <View className="relative" key={photo.uri}>
              <Image
                cachePolicy="memory-disk"
                contentFit="cover"
                source={{ uri: photo.uri }}
                style={{
                  backgroundColor: colors.muted,
                  borderRadius: 14,
                  height: 68,
                  width: 68,
                }}
              />

              <Pressable
                accessibilityLabel="Remove this photo"
                accessibilityRole="button"
                className="absolute -right-1.5 -top-1.5 h-6 w-6 items-center justify-center rounded-full"
                hitSlop={8}
                onPress={() => onRemove(photo.uri)}
                style={{ backgroundColor: colors.destructive }}
              >
                <Glyph color="#ffffff" name="close" size={14} />
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * The ring.
 *
 * A white circle inside a white ring, which is what a camera shutter looks like
 * on every phone these people own — and therefore the one control on this
 * screen that needs no label, no caption and no explaining. It stays white
 * rather than taking the brand green: it sits on a live picture whose colours
 * are whatever the room is, and white on a dark ring is the only pairing that
 * survives being pointed at a bright window.
 */
function Shutter({
  busy,
  disabled,
  onPress,
}: {
  busy: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel="Take a photo"
      accessibilityRole="button"
      accessibilityState={{ busy, disabled }}
      className={`h-16 w-16 items-center justify-center rounded-full border-[3px] border-white/90 ${
        disabled ? "opacity-40" : "active:opacity-80"
      }`}
      disabled={disabled || busy}
      hitSlop={8}
      onPress={onPress}
    >
      {busy ? (
        <ActivityIndicator color="#ffffff" size="small" />
      ) : (
        <View className="h-[52px] w-[52px] rounded-full bg-white" />
      )}
    </Pressable>
  );
}

/** A control that has to be legible on top of whatever the camera is pointed at. */
function GlassButton({
  active = false,
  icon,
  label,
  onPress,
}: {
  active?: boolean;
  icon: GlyphName;
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
      hitSlop={6}
      onPress={onPress}
    >
      <Glyph color={active ? "#000000" : "#ffffff"} name={icon} size={18} variant={active ? "solid" : "line"} />
    </Pressable>
  );
}
