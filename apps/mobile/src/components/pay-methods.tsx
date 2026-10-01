import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { Image } from "expo-image";
import { Pressable, View } from "react-native";

import { Text } from "@/components/ui/text";
import { useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { openAssetViewer } from "@/lib/asset-viewer";
import { fileAssetUrl, type GatewayProvider, type PayMethod } from "@/lib/finance-api";
import { toastSuccess } from "@/lib/toast";

/**
 * How a hostel takes money, rendered the same way wherever it is shown.
 *
 * Two screens print these details and they must not drift. The resident opens
 * their own checkout (`app/invoice/[id]/pay`); the warden reads the same
 * account number out at the intake desk, to somebody who has just been
 * registered and handed two reference codes (`manage/resident/new`). A second
 * hand-rolled account row on either is where a copy button quietly stops
 * working, or a bank name goes missing, on one screen and not the other.
 *
 * **Live checkouts are deliberately not here.** Starting one creates a payment
 * intent against the resident’s own session and hands their phone to the
 * provider — it belongs to the resident’s screen and nowhere else. This module
 * is the manual half: QR, wallet id, bank account. The half anybody may read
 * aloud.
 */

export const PROVIDER_LABEL: Record<GatewayProvider, string> = {
  ESEWA: "eSewa",
  FONEPAY: "Fonepay",
  KHALTI: "Khalti",
};

/** Unique per account: a hostel can list two banks or two eSewa ids. */
export function methodKey(method: PayMethod) {
  switch (method.kind) {
    case "GATEWAY":
      return `GATEWAY:${method.provider}`;
    case "BANK":
      return `BANK:${method.accountNumber}`;
    case "QR":
      return `QR:${method.assetId}`;
    default:
      return `${method.kind}:${method.id}`;
  }
}

export function methodLabel(method: PayMethod) {
  switch (method.kind) {
    case "GATEWAY":
      return PROVIDER_LABEL[method.provider];
    case "BANK":
      return "Bank transfer";
    case "QR":
      return "QR payment";
    case "ESEWA":
      return "eSewa";
    default:
      return "Khalti";
  }
}

/**
 * The one line under a method's name in the list.
 *
 * Says what the resident will *do*, not what the method is — "Scan QR to pay"
 * rather than "QR". A row whose subtitle restates its title is a row with an
 * empty second line, and the reference apps (`NOTES.md` §3) caption every tile
 * with the action rather than the category.
 */
export function methodCaption(method: PayMethod) {
  switch (method.kind) {
    case "GATEWAY":
      return `Pay in the ${PROVIDER_LABEL[method.provider]} app`;
    case "BANK":
      return method.bankName ?? "Pay via bank account";
    case "QR":
      return "Scan QR to pay";
    case "ESEWA":
      return "Send to the hostel's eSewa ID";
    default:
      return "Send to the hostel's Khalti ID";
  }
}

/**
 * What `<WalletMark>` should try to find a logo for.
 *
 * A `GATEWAY` carries its provider explicitly and the two wallet-id kinds *are*
 * their provider, so those are enums. A `BANK` hands over **the bank's own
 * name** — `bankName` is free text the owner typed, and matching it is exactly
 * what `resolvePaymentLogoKey` is for; a hostel banking with Everest gets
 * Everest's mark rather than a generic building glyph.
 *
 * `QR` has no brand of its own — a hostel's static QR is whatever their bank or
 * wallet printed — so it keeps its kind and gets the glyph.
 */
export function methodProvider(method: PayMethod): string {
  if (method.kind === "GATEWAY") {
    return method.provider;
  }

  if (method.kind === "BANK") {
    return method.bankName ?? method.kind;
  }

  return method.kind;
}


export function CopyButton({
  label,
  tone = "default",
  value,
}: {
  label: string;
  /**
   * `"glyph"` is the bare green icon the reference code uses — no border, no
   * "Copy" label. It is for the one place on a card where there is nothing else
   * to copy, so the chip's job of saying *which* value it takes is not needed.
   */
  tone?: "default" | "glyph";
  value: string;
}) {
  const { colors } = useAppTheme();
  const glyph = tone === "glyph";

  const copy = () => {
    void Clipboard.setStringAsync(value);
    toastSuccess("Copied");
  };

  if (glyph) {
    return (
      <Pressable
        accessibilityLabel={`Copy ${label}`}
        accessibilityRole="button"
        className="p-1 active:opacity-70"
        hitSlop={12}
        onPress={copy}
      >
        <Ionicons color={colors.brand} name="copy-outline" size={22} />
      </Pressable>
    );
  }

  return (
    <Pressable
      accessibilityLabel={`Copy ${label}`}
      accessibilityRole="button"
      className="flex-row items-center gap-1.5 rounded-lg border border-border px-3 py-2 active:opacity-70"
      onPress={copy}
    >
      <Ionicons color={colors.mutedForeground} name="copy-outline" size={14} />
      <Text variant="caption">Copy</Text>
    </Pressable>
  );
}

/** One labelled value with its own copy button — an account number, a wallet id. */
export function DetailLine({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row items-center justify-between gap-3 rounded-xl border border-border px-3 py-2.5">
      <View className="flex-1">
        <Text variant="caption">{label}</Text>
        <Text numberOfLines={1} variant="label">
          {value}
        </Text>
      </View>
      <CopyButton label={label} value={value} />
    </View>
  );
}


/**
 * One manual method’s details — everything except a live checkout.
 *
 * Handed a `GATEWAY` it renders nothing, so a caller can map over the server’s
 * whole ordered list without first filtering it. The order the server returns is
 * the order a resident should see, and a caller that filtered it itself would
 * eventually filter it differently.
 */
export function ManualMethodPanel({ method }: { method: PayMethod }) {
  if (method.kind === "GATEWAY") {
    return null;
  }

  if (method.kind === "QR") {
    return <QrPanel method={method} />;
  }

  if (method.kind === "BANK") {
    return (
      <View className="gap-2">
        {method.bankName ? <Text variant="label">{method.bankName}</Text> : null}
        {method.accountName ? (
          <DetailLine label="Account name" value={method.accountName} />
        ) : null}
        <DetailLine label="Account number" value={method.accountNumber} />
      </View>
    );
  }

  return (
    <DetailLine
      label={method.kind === "ESEWA" ? "eSewa ID" : "Khalti ID"}
      value={method.id}
    />
  );
}

/**
 * The hostel's static QR.
 *
 * Served through our own authorising route, so the bearer token has to ride on
 * the request — `expo-image` takes headers, a bare `<Image src>` does not.
 */
function QrPanel({ method }: { method: Extract<PayMethod, { kind: "QR" }> }) {
  const token = useAppSelector((state) => state.auth.accessToken);
  const { colors } = useAppTheme();

  return (
    <View className="gap-3">
      <View className="items-center gap-2 rounded-xl border border-border p-4">
        {/*
          Tappable, because 208dp of QR is scanned by *another* phone held over
          this one — and a code that will not resolve at arm's length is a
          payment that does not happen. Full-screen is the whole screen's width.
        */}
        <Pressable
          accessibilityHint="Opens the code full screen"
          accessibilityLabel="Scan to pay"
          accessibilityRole="imagebutton"
          className="active:opacity-80"
          onPress={() =>
            openAssetViewer([
              {
                assetId: method.assetId,
                caption: "Scan with any payment app",
                title: "Pay by QR",
              },
            ])
          }
        >
          <Image
            contentFit="contain"
            source={{
              headers: token ? { Authorization: `Bearer ${token}` } : undefined,
              uri: fileAssetUrl(method.assetId),
            }}
            style={{ backgroundColor: colors.card, height: 208, width: 208 }}
          />
        </Pressable>
        <Text variant="caption">Scan with any payment app</Text>
      </View>

      {/* A personal wallet's daily cap, said before they try — the network's
          rejection afterwards explains nothing. */}
      {method.notice ? (
        <View className="rounded-xl bg-warning-soft p-3">
          <Text className="text-warning" variant="caption">
            {method.notice}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
