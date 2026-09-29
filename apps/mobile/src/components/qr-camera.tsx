import { CameraView } from "expo-camera";
import { requireNativeViewManager, requireOptionalNativeModule } from "expo-modules-core";
import type { ComponentType } from "react";
import type { StyleProp, ViewStyle } from "react-native";

type Props = {
  /** False while another screen sits on top — the camera, and the torch, go off. */
  active: boolean;
  /** Every QR read, raw. Deciding whether it is ours is the caller's job. */
  onCode: (data: string) => void;
  style?: StyleProp<ViewStyle>;
  torch: boolean;
};

type NativeProps = Omit<Props, "onCode"> & {
  onCode: (event: { nativeEvent: { data: string } }) => void;
};

/*
 * `modules/hostelhub-qr-scanner` — a QR-only camera with a starting zoom, centre
 * focus and ML Kit auto-zoom; its Kotlin header has why each of those matters.
 * Asked for by name, like `native-downloads.ts`, so a build that predates the
 * module (and iOS, which has none) falls back to expo-camera rather than
 * crashing on a view that is not there.
 */
const NativeQrScanner: ComponentType<NativeProps> | null = requireOptionalNativeModule(
  "HostelHubQrScanner",
)
  ? requireNativeViewManager<NativeProps>("HostelHubQrScanner")
  : null;

/**
 * A camera that reports QR codes and nothing else.
 *
 * The web build swaps this file for `web/qr-camera.tsx`.
 */
export function QrCamera({ active, onCode, style, torch }: Props) {
  if (NativeQrScanner) {
    return (
      <NativeQrScanner
        active={active}
        onCode={(event) => onCode(event.nativeEvent.data)}
        style={style}
        torch={torch}
      />
    );
  }

  return (
    <CameraView
      active={active}
      barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
      enableTorch={torch}
      facing="back"
      onBarcodeScanned={({ data }) => onCode(data)}
      style={style}
    />
  );
}
