import { useEffect, useRef, useState } from "react";
import { PanResponder, Pressable, View } from "react-native";

import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import {
  SIGNATURE_HEIGHT,
  SIGNATURE_WIDTH,
  type SignatureStroke,
  serializeSignature,
  signatureStrokes,
} from "@/lib/signature";

/**
 * Signature strokes, drawn as thin rotated views.
 *
 * No SVG library: `react-native-svg` is not in this app, and adding a native
 * module would mean a new binary instead of an over-the-air update. A line segment is
 * just a rounded bar, and a signature is a few hundred of them. Each bar is
 * lengthened by its own thickness so the rounded ends overlap into smooth
 * joints.
 *
 * Used by the pad below and by the back of the ID card.
 */
export function SignatureInk({
  color,
  height,
  strokes,
  width,
}: {
  color: string;
  height: number;
  strokes: SignatureStroke[];
  width: number;
}) {
  const scale = Math.min(width / SIGNATURE_WIDTH, height / SIGNATURE_HEIGHT);
  const thickness = Math.max(1.5, 5 * scale);
  const offsetX = (width - SIGNATURE_WIDTH * scale) / 2;
  const offsetY = (height - SIGNATURE_HEIGHT * scale) / 2;
  const bars: React.ReactNode[] = [];

  strokes.forEach((stroke, strokeIndex) => {
    const first = stroke[0];

    if (!first) {
      return;
    }

    // A tap is a dot, not nothing.
    const points = stroke.length > 1 ? stroke : [first, [first[0] + 0.5, first[1]]];

    for (let index = 1; index < points.length; index += 1) {
      const [x1, y1] = points[index - 1]!;
      const [x2, y2] = points[index]!;
      const ax = offsetX + x1 * scale;
      const ay = offsetY + y1 * scale;
      const bx = offsetX + x2 * scale;
      const by = offsetY + y2 * scale;
      const length = Math.hypot(bx - ax, by - ay) + thickness;

      bars.push(
        <View
          key={`${strokeIndex}-${index}`}
          style={{
            backgroundColor: color,
            borderRadius: thickness / 2,
            height: thickness,
            left: (ax + bx) / 2 - length / 2,
            position: "absolute",
            top: (ay + by) / 2 - thickness / 2,
            transform: [{ rotate: `${Math.atan2(by - ay, bx - ax)}rad` }],
            width: length,
          }}
        />,
      );
    }
  });

  return (
    <View pointerEvents="none" style={{ height, width }}>
      {bars}
    </View>
  );
}

/**
 * The pad is taller than the signature it records — 1.4:1 on screen, so there is
 * room to sign — while strokes are still stored in the card's 3:1 space. The
 * stored band sits centred, and a touch above or below it lands on its edge.
 */
const PAD_RATIO = 1.4;

/** Distance from the pad's top edge to the top of the stored 3:1 band. */
function bandInset(padWidth: number): number {
  return (padWidth / PAD_RATIO - padWidth / (SIGNATURE_WIDTH / SIGNATURE_HEIGHT)) / 2;
}

/**
 * Where the holder signs. Owns its strokes while drawing and reports the
 * serialised value on every lift of the finger.
 *
 * `onActiveChange` exists because a vertical stroke inside a ScrollView is also
 * a scroll: on Android the native ScrollView takes the touch away from any JS
 * responder no matter what it asks. The screen turns scrolling off while this
 * reports `true`.
 */
export function SignaturePad({
  error,
  onActiveChange,
  onChange,
  value,
}: {
  error?: string | null;
  onActiveChange?: (active: boolean) => void;
  onChange: (value: string) => void;
  value: string;
}) {
  const { colors } = useAppTheme();
  const [width, setWidth] = useState(0);
  const [strokes, setStrokes] = useState<SignatureStroke[]>(() =>
    signatureStrokes(value),
  );
  const live = useRef(strokes);
  const widthRef = useRef(0);
  const handlers = useRef({ onActiveChange, onChange });

  useEffect(() => {
    handlers.current = { onActiveChange, onChange };
  });

  // Built once; every callback reads the refs at gesture time, never in render.
  // eslint-disable-next-line react-hooks/refs -- PanResponder.create stores the callbacks, it does not call them
  const [responder] = useState(() => {
    const toPoint = (x: number, y: number): [number, number] => {
      const padWidth = widthRef.current || 1;
      const scale = SIGNATURE_WIDTH / padWidth;

      return [
        Math.min(SIGNATURE_WIDTH, Math.max(0, x * scale)),
        Math.min(SIGNATURE_HEIGHT, Math.max(0, (y - bandInset(padWidth)) * scale)),
      ];
    };

    const finish = () => {
      handlers.current.onActiveChange?.(false);
      handlers.current.onChange(serializeSignature(live.current));
    };

    return PanResponder.create({
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (event) => {
        handlers.current.onActiveChange?.(true);
        live.current = [
          ...live.current,
          [toPoint(event.nativeEvent.locationX, event.nativeEvent.locationY)],
        ];
        setStrokes(live.current);
      },
      onPanResponderMove: (event) => {
        const point = toPoint(event.nativeEvent.locationX, event.nativeEvent.locationY);
        const current = live.current[live.current.length - 1];
        const last = current?.[current.length - 1];

        // Points closer than this add bars without adding shape.
        if (!current || !last || Math.hypot(point[0] - last[0], point[1] - last[1]) < 3) {
          return;
        }

        live.current = [...live.current.slice(0, -1), [...current, point]];
        setStrokes(live.current);
      },
      onPanResponderRelease: finish,
      onPanResponderTerminate: finish,
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onStartShouldSetPanResponder: () => true,
    });
  });

  const clear = () => {
    live.current = [];
    setStrokes([]);
    onChange("");
  };

  const height = width / PAD_RATIO;

  return (
    <View className="gap-1.5">
      <View
        className={`overflow-hidden rounded-2xl border border-dashed ${
          error ? "border-destructive" : "border-muted-foreground/50"
        }`}
        onLayout={(event) => {
          widthRef.current = event.nativeEvent.layout.width;
          setWidth(event.nativeEvent.layout.width);
        }}
        style={{ aspectRatio: PAD_RATIO }}
        {...responder.panHandlers}
      >
        {strokes.length === 0 ? (
          <Text
            className="absolute text-center"
            pointerEvents="none"
            style={{ bottom: 12, left: 0, right: 0 }}
            variant="muted"
          >
            Sign here with your finger
          </Text>
        ) : null}
        {width > 0 ? (
          <SignatureInk
            color={colors.foreground}
            height={height}
            strokes={strokes}
            width={width}
          />
        ) : null}
      </View>

      <View className="flex-row items-center justify-between">
        {error ? (
          <Text className="flex-1 text-destructive" variant="caption">
            {error}
          </Text>
        ) : (
          <View className="flex-1" />
        )}
        {strokes.length > 0 ? (
          <Pressable accessibilityRole="button" hitSlop={10} onPress={clear}>
            <Text className="text-primary" variant="label">
              Clear
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
