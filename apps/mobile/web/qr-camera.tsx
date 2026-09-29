import { useEffect, useRef } from "react";
import { type StyleProp, View, type ViewStyle } from "react-native";

type Props = {
  active: boolean;
  onCode: (data: string) => void;
  style?: StyleProp<ViewStyle>;
  torch: boolean;
};

type Detector = { detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]> };
type DetectorClass = {
  new (options: { formats: string[] }): Detector;
  getSupportedFormats(): Promise<string[]>;
};

/** What Chrome on Android exposes on a rear camera and lib.dom does not type. */
type CameraCapabilities = MediaTrackCapabilities & {
  focusMode?: string[];
  torch?: boolean;
  zoom?: { max: number; min: number };
};

/** Matches the phone's `START_ZOOM`: a card filling the brackets stays outside the lens's minimum focus distance. */
const START_ZOOM = 2;
/** A card held still reads on every frame; the caller needs it once. */
const REPEAT_MS = 1500;

/**
 * `@/components/qr-camera` for the installable web app. `metro.config.js` swaps
 * it in for the web bundle only.
 *
 * expo-camera's web camera asked the browser for its default stream — 640×480
 * on most phones, fixed focus distance left to chance — and looked at it every
 * 300 ms. So this asks for an HD rear stream, switches on continuous focus and a
 * 2× zoom wherever the browser exposes them (Chrome on Android does), and reads
 * every new frame the moment the previous read finishes.
 *
 * The detector is the browser's own `BarcodeDetector` where it reads QR (Chrome
 * on Android), and the zxing-wasm ponyfill everywhere else — iPhone Safari has
 * none — which is the same package expo-camera falls back to.
 */
export function QrCamera({ active, onCode, style, torch }: Props) {
  const video = useRef<HTMLVideoElement | null>(null);
  const track = useRef<MediaStreamTrack | null>(null);
  const latest = useRef({ onCode, torch });

  useEffect(() => {
    latest.current = { onCode, torch };
  });

  useEffect(() => {
    const element = video.current;

    if (!active || !element) {
      return;
    }

    let stopped = false;
    let stream: MediaStream | null = null;
    let last = { at: 0, code: "" };

    function nextFrame(read: () => void) {
      if (stopped || !element) return;
      if ("requestVideoFrameCallback" in element) {
        element.requestVideoFrameCallback(read);
      } else {
        requestAnimationFrame(read);
      }
    }

    async function start() {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" }, height: { ideal: 1080 }, width: { ideal: 1920 } },
      });

      if (stopped || !element) {
        stream.getTracks().forEach((each) => each.stop());
        return;
      }

      const [camera] = stream.getVideoTracks();
      track.current = camera;
      await tune(camera, latest.current.torch);

      element.srcObject = stream;
      await element.play();

      const detector = await createDetector();

      const read = async () => {
        if (stopped) return;

        try {
          const [code] = await detector.detect(element);
          const now = Date.now();

          if (code?.rawValue && !stopped && (code.rawValue !== last.code || now - last.at > REPEAT_MS)) {
            last = { at: now, code: code.rawValue };
            latest.current.onCode(code.rawValue);
          }
        } catch {
          // A frame the decoder could not take (still loading, resized). The next one will do.
        }

        nextFrame(read);
      };

      nextFrame(read);
    }

    // Refused or unavailable: the scanner screen already shows the
    // permission card and the type-it-in button for exactly this.
    start().catch(() => undefined);

    return () => {
      stopped = true;
      track.current = null;
      stream?.getTracks().forEach((each) => each.stop());
      element.srcObject = null;
    };
  }, [active]);

  useEffect(() => {
    if (track.current) {
      void tune(track.current, torch);
    }
  }, [torch]);

  return (
    <View style={style}>
      <video
        autoPlay
        muted
        playsInline
        ref={video}
        style={{ height: "100%", objectFit: "cover", width: "100%" }}
      />
    </View>
  );
}

/** Applies what this camera supports and quietly skips what it does not. */
async function tune(camera: MediaStreamTrack, torch: boolean) {
  const can = (camera.getCapabilities?.() ?? {}) as CameraCapabilities;
  const wanted: Record<string, unknown> = {};

  if (can.focusMode?.includes("continuous")) wanted.focusMode = "continuous";
  if (can.zoom) wanted.zoom = Math.min(Math.max(START_ZOOM, can.zoom.min), can.zoom.max);
  if (can.torch) wanted.torch = torch;

  // One constraint per entry: a browser that rejects one keeps the rest.
  for (const [key, value] of Object.entries(wanted)) {
    await camera.applyConstraints({ advanced: [{ [key]: value }] }).catch(() => undefined);
  }
}

let detector: Promise<Detector> | null = null;

function createDetector() {
  detector ??= (async () => {
    const Native = (globalThis as { BarcodeDetector?: DetectorClass }).BarcodeDetector;

    if (Native && (await Native.getSupportedFormats()).includes("qr_code")) {
      return new Native({ formats: ["qr_code"] });
    }

    const { BarcodeDetector } = await import("barcode-detector/ponyfill");
    return new BarcodeDetector({ formats: ["qr_code"] }) as Detector;
  })().catch((error: unknown) => {
    // Let the next scanner that opens try again rather than inherit the failure.
    detector = null;
    throw error;
  });

  return detector;
}
