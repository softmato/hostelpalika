import { Ionicons } from "@expo/vector-icons";
import { File } from "expo-file-system";
import { Image } from "expo-image";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { WebView } from "react-native-webview";

import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { api, API_BASE_URL } from "@/lib/api";
import { type ApiEnvelope, unwrap } from "@/lib/api-contract";
import { absoluteMediaUrl } from "@/lib/media";

/**
 * The file the resident just attached, drawn as itself.
 *
 * ## Why a PDF has to be rendered rather than named
 *
 * A screenshot has always shown as a picture here. A PDF showed as the sentence
 * "PDF receipt uploaded", which answers *did the upload work* and not *is this
 * the right file* — and the resident is being asked, two rows below, to check an
 * amount and a ten-digit transaction id **we read off this document**. Nobody
 * can check a number against a filename. Worse, a bank receipt is the case most
 * likely to arrive as a PDF and the case where the transaction id matters most.
 *
 * So it renders. First page, at the width of the card, from the file on the
 * phone — which means it appears the instant it is picked, before a byte has
 * been uploaded, and does not need the network or a token to be seen.
 *
 * ## pdf.js in a WebView, and why not something simpler
 *
 * There is no simpler thing that works on both platforms. `WKWebView` renders a
 * PDF handed to it directly; Android's WebView renders nothing at all and offers
 * to download the file instead, so a `data:` URI or a remote URL draws a blank
 * card on the phones most of this product's residents actually hold. pdf.js
 * rasterises the page itself, in JavaScript, so both platforms draw the same
 * thing.
 *
 * The library comes from a CDN, which is the same trade `components/hostel-map.tsx`
 * already makes for Leaflet — and it fails the same way, into
 * {@link DocumentCard}, which is exactly the card this replaced. A resident with
 * no connection could not have uploaded the file in the first place.
 *
 * ## The size guard is not a formality
 *
 * The bytes cross the React Native bridge as a base64 string inside the page's
 * HTML, and base64 is a third larger again. A 10MB PDF — the platform's upload
 * ceiling — would be a 13MB string handed across the bridge on a phone that is
 * mid-upload, which is how a low-end Android device dies during a payment. Above
 * {@link INLINE_PDF_LIMIT} it stays the named card, which still opens the full
 * viewer on tap.
 */

/** The pinned pdf.js. UMD rather than the ESM build: older Android WebViews. */
const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174";

/**
 * The largest PDF drawn inline: 4MB, so about 5.5MB of base64 on the bridge.
 *
 * Comfortably above every bank and wallet receipt seen in testing — those run
 * tens of kilobytes — and comfortably below the 10MB upload ceiling, which is
 * sized for the photograph of a paper receipt rather than for a document.
 */
const INLINE_PDF_LIMIT = 4 * 1024 * 1024;

/** How tall the preview is, images and documents alike. */
const PREVIEW_HEIGHT = 220;

export function isPdfReceipt(mimeType: string | undefined): boolean {
  return (mimeType ?? "").includes("pdf");
}

export function ReceiptPreview({
  mimeType,
  onPress,
  uri,
}: {
  mimeType?: string;
  /** Opens the full-screen viewer. */
  onPress?: () => void;
  /** The file on **this phone**, so the preview does not wait for the upload. */
  uri: string;
}) {
  const { colors } = useAppTheme();

  if (!isPdfReceipt(mimeType)) {
    return (
      <Pressable
        accessibilityHint="Opens it full screen"
        accessibilityLabel="View the receipt you uploaded"
        accessibilityRole="button"
        className="self-stretch active:opacity-80"
        disabled={!onPress}
        onPress={onPress}
      >
        {/* `contain`, not `cover`: a bank screenshot is tall and narrow, and
            cropping it to fill cuts off the transaction id — the one thing the
            resident is here to check against the field we filled in for them. */}
        <Image
          contentFit="contain"
          source={{ uri }}
          style={{
            backgroundColor: colors.muted,
            borderRadius: 12,
            height: PREVIEW_HEIGHT,
            width: "100%",
          }}
        />
      </Pressable>
    );
  }

  // Keyed: a re-picked file must be read again, not the first one kept.
  return <PdfPreview key={uri} onPress={onPress} read={() => readLocalPdf(uri)} />;
}

/** The picked file, as base64 — or null when it is gone or too big to inline. */
async function readLocalPdf(uri: string) {
  const file = new File(uri);

  return !file.exists || (file.size ?? 0) > INLINE_PDF_LIMIT ? null : file.base64();
}

/**
 * An uploaded PDF, as base64. A private asset's signed address comes from the
 * authorising route as JSON and is fetched with no token: R2 reads any
 * `Authorization` header as a signature and refuses it (see `viewerSourceFor`).
 */
export async function readRemotePdf(item: { assetId?: string; url?: string }): Promise<string | null> {
  const address = item.assetId
    ? unwrap(
        await api.get<ApiEnvelope<{ url: string }>>(`/files/${item.assetId}/url`, {
          params: { format: "json" },
        }),
      ).url
    : absoluteMediaUrl(item.url, API_BASE_URL);

  if (!address) return null;

  const response = await fetch(address);

  if (!response.ok) return null;

  const blob = await response.blob();

  if (blob.size > INLINE_PDF_LIMIT) return null;

  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? null);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * A PDF drawn by pdf.js: page one in a card, or with `allPages` every page in a
 * scrolling column on black — the asset viewer's page for a document.
 */
export function PdfPreview({
  allPages = false,
  height = PREVIEW_HEIGHT,
  label = "View the PDF receipt you uploaded",
  onPress,
  read,
}: {
  allPages?: boolean;
  height?: number;
  label?: string;
  onPress?: () => void;
  /** Base64 of the document, or null when it cannot be drawn here. */
  read: () => Promise<string | null>;
}) {
  const { colors } = useAppTheme();
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // Read once per mount: callers pass a fresh arrow every render.
  const [reader] = useState(() => read);

  useEffect(() => {
    let live = true;

    void (async () => {
      try {
        const base64 = await reader();

        if (!live) return;
        if (base64) setHtml(pageFor(base64, allPages));
        else setFailed(true);
      } catch {
        if (live) setFailed(true);
      }
    })();

    return () => {
      live = false;
    };
  }, [allPages, reader]);

  if (failed) {
    return allPages ? (
      <View className="flex-1 items-center justify-center px-8">
        <Text className="text-center text-sm text-white/70" variant={null}>
          This file could not be shown here. Use Save to open it.
        </Text>
      </View>
    ) : (
      <DocumentCard onPress={onPress} />
    );
  }

  return (
    <Pressable
      accessibilityHint="Opens it full screen"
      accessibilityLabel={label}
      accessibilityRole="button"
      className={allPages ? "flex-1" : "self-stretch overflow-hidden rounded-xl active:opacity-80"}
      disabled={!onPress}
      onPress={onPress}
      style={{ backgroundColor: allPages ? "#000000" : colors.muted, height }}
    >
      {html ? (
        <WebView
          // Nothing here needs storage, cookies or a file handle — the document
          // is already inside the page as bytes.
          allowFileAccess={false}
          androidLayerType="hardware"
          domStorageEnabled={false}
          javaScriptEnabled
          onError={() => setFailed(true)}
          // pdf.js reports its own failures, which a WebView `onError` does not
          // see: a corrupt document loads the page perfectly and then throws.
          onMessage={(event) => {
            if (event.nativeEvent.data === "failed") setFailed(true);
          }}
          originWhitelist={["*"]}
          renderError={() => <DocumentCard onPress={onPress} />}
          scrollEnabled={allPages}
          setSupportMultipleWindows={false}
          source={{ html }}
          style={{ backgroundColor: allPages ? "#000000" : colors.muted, flex: 1 }}
        />
      ) : (
        <View className="flex-1 items-center justify-center gap-2">
          <ActivityIndicator color={allPages ? "#ffffff" : colors.primary} size="small" />
          {allPages ? null : <Text variant="caption">Opening…</Text>}
        </View>
      )}

      {/* The WebView swallows the touch even with scrolling off, so the tap
          target is drawn over it rather than under it. */}
      {onPress ? (
        <Pressable
          accessibilityLabel={label}
          accessibilityRole="button"
          className="absolute inset-0"
          onPress={onPress}
        />
      ) : null}
    </Pressable>
  );
}

/** What a document falls back to: named in words, still tappable. */
function DocumentCard({ onPress }: { onPress?: () => void }) {
  const { colors } = useAppTheme();

  return (
    <Pressable
      accessibilityLabel="Open the PDF receipt you uploaded"
      accessibilityRole="button"
      className="w-full flex-row items-center gap-3 rounded-xl bg-muted/40 px-4 py-6 active:opacity-80"
      disabled={!onPress}
      onPress={onPress}
    >
      <Ionicons color={colors.primary} name="document-text" size={24} />
      <Text className="flex-1" variant="label">
        PDF receipt uploaded — tap to open it
      </Text>
    </Pressable>
  );
}

/**
 * The page that draws page one.
 *
 * Rendered at twice the CSS width so the transaction id stays legible on a
 * phone's pixel ratio, then laid out at 100% — the resident is reading a
 * ten-digit number off it, and a canvas rasterised at CSS resolution turns that
 * into a grey smear.
 *
 * Top-aligned inside a fixed-height box rather than fitted to it: every receipt
 * layout in Nepal puts the amount and the id in the upper half, so showing the
 * top of the page at a readable size beats showing all of it at an unreadable
 * one.
 */
function pageFor(base64: string, allPages = false) {
  return `<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1${allPages ? ",maximum-scale=5" : ""}">
<style>
  html,body{margin:0;padding:0;background:${allPages ? "#000" : "#fff"};overflow:${allPages ? "auto" : "hidden"}}
  canvas{display:block;width:100%;background:#fff}
  canvas+canvas{margin-top:8px}
</style>
<div id="pages"></div>
<script src="${PDFJS}/pdf.min.js"></script>
<script>
  var fail = function () {
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage("failed");
  };

  try {
    pdfjsLib.GlobalWorkerOptions.workerSrc = "${PDFJS}/pdf.worker.min.js";

    var raw = atob("${base64}");
    var bytes = new Uint8Array(raw.length);

    for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

    var draw = function (doc, number) {
      return doc.getPage(number).then(function (page) {
        var canvas = document.createElement("canvas");
        var context = canvas.getContext("2d");
        var natural = page.getViewport({ scale: 1 });
        var viewport = page.getViewport({ scale: (window.innerWidth * 2) / natural.width });

        canvas.width = viewport.width;
        canvas.height = viewport.height;
        document.getElementById("pages").appendChild(canvas);

        return page.render({ canvasContext: context, viewport: viewport }).promise;
      });
    };

    pdfjsLib.getDocument({ data: bytes }).promise.then(function (doc) {
      var last = ${allPages ? "doc.numPages" : "1"};
      var chain = Promise.resolve();

      for (var n = 1; n <= last; n++) {
        chain = chain.then(draw.bind(null, doc, n));
      }

      return chain;
    }).catch(fail);
  } catch (error) {
    fail();
  }
</script>`;
}
