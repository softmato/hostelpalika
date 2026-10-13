import { Ionicons } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Linking, Modal, Pressable, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useSystemInsets } from "@/hooks/use-system-insets";
import { centredGuide, cropRectForGuide } from "@/lib/capture-crop";
import { toastError } from "@/lib/toast";
import { APP_NAME } from "@/constants/branding";

/**
 * A full-screen camera that asks for one specific picture, and crops to the
 * frame it drew.
 *
 * ## Why this is not `PhotoCapture`
 *
 * That component is a viewfinder embedded in a page, taking several loose shots
 * of a broken tap. This one is a guided capture of a *document*: there is
 * exactly one right answer, the framing is part of it, and the picture is
 * cropped to the frame rather than kept whole. A photograph of a signature with
 * half a desk around it prints as a grey smudge 240 points wide on the back of
 * the card, so the crop is not a nicety.
 *
 * It takes the whole screen because a guide frame sharing a page with form
 * fields is a guide frame nobody lines anything up with — the banking apps
 * these residents already use put document capture on its own black surface for
 * the same reason.
 *
 * ## Confirm, then use
 *
 * Retake / Use this, shown on the *cropped* result rather than on the raw shot.
 * The cropped result is what goes on the card, so it is the only thing worth
 * approving; showing the full frame and cropping afterwards is how somebody
 * accepts a photograph and then finds their signature clipped.
 *
 * ## The palette here is black and white, not the brand's
 *
 * Deliberate, and the one place in the app where that is right: these controls
 * sit on a live picture whose colours are whatever the room is, and green on a
 * sunlit wall is unreadable. The brand green comes back the instant the picture
 * is taken, on the Use this button.
 */

export type GuideShape = "document" | "face" | "signature";

const GUIDES = {
  /** A citizenship card or ID — the credit-card ratio, back camera. */
  document: {
    aspectRatio: 1.586,
    facing: "back" as const,
    hint: "Fit the whole document inside the frame, flat and in good light.",
    inset: 0.05,
    title: "Photograph the document",
  },
  face: {
    /** Square: the card crops it to a circle, and a circle inside a square is safe. */
    aspectRatio: 1,
    facing: "front" as const,
    hint: "Fit your face in the oval. Plain background, no hat.",
    inset: 0.12,
    title: "Take your photo",
  },
  signature: {
    /**
     * 2:1, taller than the card's 3:1 box: a 3:1 frame was a sliver of the
     * viewfinder that a real signature on paper rarely fit inside. Whatever
     * prints it into a 3:1 box has to fit it, not stretch it.
     */
    aspectRatio: 2,
    facing: "back" as const,
    hint: "Sign on white paper and fit it inside the frame.",
    inset: 0.06,
    title: "Photograph your signature",
  },
};

const FILL = {
  bottom: 0,
  left: 0,
  position: "absolute",
  right: 0,
  top: 0,
} as const;

export function GuidedCapture({
  onCancel,
  onConfirm,
  shape,
  visible,
}: {
  onCancel: () => void;
  /** A local `file://` uri, already cropped to the frame. Nothing is uploaded. */
  onConfirm: (uri: string) => void;
  shape: GuideShape;
  visible: boolean;
}) {
  const guide = GUIDES[shape];
  const insets = useSystemInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const camera = useRef<CameraView>(null);
  const [facing, setFacing] = useState<"back" | "front">(guide.facing);
  const [shooting, setShooting] = useState(false);
  const [preview, setPreview] = useState<{ height: number; width: number } | null>(null);
  const [shot, setShot] = useState<string | null>(null);

  const reset = useCallback(() => {
    setShot(null);
    setFacing(guide.facing);
  }, [guide.facing]);

  const close = useCallback(() => {
    reset();
    onCancel();
  }, [onCancel, reset]);

  const shoot = useCallback(async () => {
    if (!camera.current || shooting || !preview) {
      return;
    }

    setShooting(true);

    try {
      /*
       * `skipProcessing` is left alone on purpose — it is faster and it also
       * skips the rotation fix, and a signature lying on its side is a
       * signature nobody can read. Quality is 0.9 where the complaint camera's
       * is 0.7: this is cropped to a fraction of the frame afterwards, so the
       * compression is spent on a region rather than on a whole picture, and a
       * JPEG-mushed hairline stroke does not come back.
       */
      const picture = await camera.current.takePictureAsync({
        quality: 0.9,
        shutterSound: false,
      });

      if (!picture?.uri) {
        toastError("That did not take", "Try the shutter again.");

        return;
      }

      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setShot(await cropToGuide(picture, preview, guide.aspectRatio, guide.inset));
    } catch {
      toastError("The camera did not respond", "Try the shutter again.");
    } finally {
      setShooting(false);
    }
  }, [guide.aspectRatio, guide.inset, preview, shooting]);

  const frame = preview ? centredGuide(preview, guide.aspectRatio, guide.inset) : null;

  return (
    <Modal
      animationType="slide"
      onRequestClose={close}
      statusBarTranslucent
      visible={visible}
    >
      <View className="flex-1 bg-black">
        <View
          className="flex-row items-center gap-3 px-4 pb-3"
          style={{ paddingTop: insets.top + 8 }}
        >
          <Pressable
            accessibilityLabel="Close the camera"
            accessibilityRole="button"
            hitSlop={12}
            onPress={close}
          >
            <Ionicons color="#ffffff" name="close" size={26} />
          </Pressable>
          <Text className="flex-1 text-white" numberOfLines={1} variant="subtitle">
            {guide.title}
          </Text>
        </View>

        <View
          className="flex-1"
          onLayout={(event) =>
            setPreview({
              height: event.nativeEvent.layout.height,
              width: event.nativeEvent.layout.width,
            })
          }
        >
          {shot ? (
            <Image
              contentFit="contain"
              source={{ uri: shot }}
              style={{ flex: 1 }}
              transition={120}
            />
          ) : permission?.granted ? (
            <>
              <CameraView facing={facing} ref={camera} style={FILL} />
              {frame ? <GuideFrame frame={frame} shape={shape} /> : null}
            </>
          ) : (
            <View className="flex-1 items-center justify-center gap-4 px-8">
              <Ionicons color="#ffffff" name="camera-outline" size={32} />
              <Text className="text-center text-white/80" variant="body">
                {permission?.canAskAgain === false
                  ? `Camera access is off for ${APP_NAME}. Turn it on in Settings.`
                  : `${APP_NAME} needs the camera for this.`}
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
                variant="secondary"
              />
            </View>
          )}
        </View>

        <View
          className="gap-4 px-5 pt-4"
          style={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
        >
          {shot ? (
            <View className="flex-row gap-3">
              <View className="flex-1">
                <Button label="Retake" onPress={reset} variant="outline" />
              </View>
              <View className="flex-1">
                <Button
                  label="Use this"
                  onPress={() => {
                    const uri = shot;

                    reset();
                    onConfirm(uri);
                  }}
                />
              </View>
            </View>
          ) : (
            <>
              <Text className="text-center text-white/70" variant="caption">
                {guide.hint}
              </Text>
              <View className="flex-row items-center justify-between">
                {/* Balances the shutter into the centre of the row. */}
                <View className="w-11" />
                <Shutter
                  busy={shooting}
                  disabled={!permission?.granted || !preview}
                  onPress={() => void shoot()}
                />
                <Pressable
                  accessibilityLabel="Switch camera"
                  accessibilityRole="button"
                  className="h-11 w-11 items-center justify-center rounded-full bg-white/15 active:opacity-70"
                  hitSlop={6}
                  onPress={() =>
                    setFacing((current) => (current === "back" ? "front" : "back"))
                  }
                >
                  <Ionicons color="#ffffff" name="camera-reverse-outline" size={20} />
                </Pressable>
              </View>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

/**
 * The frame, drawn as four dimmed panels around a clear middle rather than as a
 * bordered box on top of the picture. A border says "aim here"; a dimmed
 * surround says "this is what will be kept", which is the honest description of
 * what the shutter is about to do.
 */
function GuideFrame({
  frame,
  shape,
}: {
  frame: { height: number; width: number; x: number; y: number };
  shape: GuideShape;
}) {
  /*
   * Typed as a percentage literal, not as `string`. React Native's `ViewStyle`
   * accepts `number | \`${number}%\``, and a plain `string` is rejected by the
   * compiler even when every value it produces is valid.
   */
  const percent = (value: number): `${number}%` =>
    `${Math.max(0, Math.min(100, value * 100))}%`;
  const shade = "rgba(0,0,0,0.55)";

  return (
    <View pointerEvents="none" style={FILL}>
      <View
        style={{
          backgroundColor: shade,
          bottom: percent(1 - frame.y),
          left: 0,
          position: "absolute",
          right: 0,
          top: 0,
        }}
      />
      <View
        style={{
          backgroundColor: shade,
          bottom: 0,
          left: 0,
          position: "absolute",
          right: 0,
          top: percent(frame.y + frame.height),
        }}
      />
      <View
        style={{
          backgroundColor: shade,
          bottom: percent(1 - frame.y - frame.height),
          left: 0,
          position: "absolute",
          right: percent(1 - frame.x),
          top: percent(frame.y),
        }}
      />
      <View
        style={{
          backgroundColor: shade,
          bottom: percent(1 - frame.y - frame.height),
          left: percent(frame.x + frame.width),
          position: "absolute",
          right: 0,
          top: percent(frame.y),
        }}
      />

      <View
        style={{
          borderColor: "rgba(255,255,255,0.9)",
          /*
           * An oval for a face, a rounded rectangle for a sheet of paper. The
           * shape is the instruction — nobody reads a caption before lining up
           * a shot.
           */
          borderRadius: shape === "face" ? 9999 : 14,
          borderWidth: 2,
          height: percent(frame.height),
          left: percent(frame.x),
          position: "absolute",
          top: percent(frame.y),
          width: percent(frame.width),
        }}
      />
    </View>
  );
}

/**
 * The ring — the same white circle in a white ring `PhotoCapture` draws, for
 * the same reason: it is what a shutter looks like on every phone these
 * residents own, so it needs no label and survives being pointed at a window.
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
      accessibilityLabel="Take the photo"
      accessibilityRole="button"
      accessibilityState={{ busy, disabled }}
      className={`h-[72px] w-[72px] items-center justify-center rounded-full border-[3px] border-white/90 ${
        disabled ? "opacity-40" : "active:opacity-80"
      }`}
      disabled={disabled || busy}
      hitSlop={8}
      onPress={onPress}
    >
      {busy ? (
        <ActivityIndicator color="#ffffff" size="small" />
      ) : (
        <View className="h-[58px] w-[58px] rounded-full bg-white" />
      )}
    </Pressable>
  );
}

type Manipulator = typeof import("expo-image-manipulator");

/** `expo-image-manipulator`, or null on a binary that predates it. */
function loadManipulator(): Manipulator | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("expo-image-manipulator") as Manipulator;
  } catch {
    return null;
  }
}

/**
 * The photograph, cut down to the guide frame.
 *
 * Returns the **uncropped** shot on any failure rather than nothing at all: an
 * uncropped signature still reads on the card, badly, and somebody who has just
 * taken a picture should not be told the app cannot use it. Same rule as
 * `prepareEvidenceForUpload` — the manipulator is an improvement, never a
 * dependency.
 */
async function cropToGuide(
  picture: { height?: number; uri: string; width?: number },
  preview: { height: number; width: number },
  aspectRatio: number,
  inset: number,
): Promise<string> {
  const manipulator = loadManipulator();

  if (!manipulator || !picture.width || !picture.height) {
    return picture.uri;
  }

  try {
    const rect = cropRectForGuide(
      { height: picture.height, width: picture.width },
      preview,
      centredGuide(preview, aspectRatio, inset),
    );
    const image = await manipulator.ImageManipulator.manipulate(picture.uri)
      .crop(rect)
      .renderAsync();
    const saved = await image.saveAsync({
      compress: 0.92,
      format: manipulator.SaveFormat.JPEG,
    });

    return saved.uri;
  } catch {
    return picture.uri;
  }
}
