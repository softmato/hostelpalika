import { Image } from "expo-image";
import { View } from "react-native";

import { Glyph } from "@/components/ui/glyph";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import {
  PAYMENT_FALLBACK_GLYPH,
  type PaymentLogoKey,
  resolvePaymentLogoKey,
  WALLET_LABEL,
  walletLabel,
} from "@/lib/payment-logos";

// Shared with the web portals (`packages/shared/src/constants/payment-logos.ts`).
export { WALLET_LABEL, walletLabel };

/**
 * A payment provider or bank's own logo, in a tile.
 *
 * ## Why the app has these at all now
 *
 * Three screens used to say, in their own words, that it could not: the
 * statements importer drew a green lettermark and its comment read "a brand's
 * actual logo would be better and there is nowhere in this repo to take one
 * from"; both statement screens mapped eSewa and Khalti to the *same*
 * `phone-portrait` glyph, so the two wallets a resident actually uses
 * were indistinguishable on a ledger row. The owner supplied the three wallet
 * marks on 2026-09-05, and the fifty bank marks the same day.
 *
 * ## It takes a *name*, not only an enum
 *
 * `ESEWA` is an enum the server picks from. `"Everest Bank Limited"` is free
 * text an owner typed into their payment setup, and the same institution
 * arrives spelled five ways. `resolvePaymentLogoKey` does that matching and is
 * where the reasoning and the tests live; this file only holds the pictures.
 *
 * ## Every mark sits on a white tile, in both themes
 *
 * Not decoration — it is the only way these three can share a component.
 * Fonepay's wordmark sets `pay` in near-black, which vanishes on a dark card;
 * Khalti's shield is deep purple, which is nearly as bad; eSewa's disc has a
 * white letter knocked out of it and needs a light ground to read as a disc at
 * all. A fixed white tile is what every banking app does with a third party's
 * mark, and it is also what keeps `CLAUDE.md`'s palette rule true: the brand
 * colours stay inside a container that is visibly *theirs*, rather than leaking
 * onto our surfaces.
 *
 * The tile is a literal white with a hairline of black at 8%, not a token. A
 * themed `bg-card` would go dark in dark mode, which is the exact failure this
 * exists to prevent.
 *
 * ## Aspect ratio is preserved, so Fonepay is allowed to be wide
 *
 * The assets are trimmed to their ink: eSewa and Khalti are square, Fonepay is
 * a 256×78 wordmark. `contentFit="contain"` inside a square tile draws it small
 * and centred, which is correct — squashing a wordmark to fill a square is the
 * one thing a brand guideline always forbids.
 *
 * ## An unmapped provider gets a glyph, never a guess
 *
 * `BANK`, `CASH` and anything a future server adds fall through to a glyph in
 * the muted tone. Degrading to a *wrong* brand mark would be worse than having
 * none, and the statements screen's original note already made that argument.
 */

/**
 * One `require()` per key in `PAYMENT_LOGO_KEYS`.
 *
 * Metro resolves `require()` of an asset statically, so this cannot be built
 * from the key list at runtime — the paths have to be literals. The `Record`
 * annotation is what keeps it honest: adding a key without an asset, or an
 * asset without a key, fails the typecheck rather than shipping a blank tile.
 *
 * Which folder a key lives in is not arbitrary. `wallets/` are the three
 * gateway marks the owner supplied as files; `banks/` are the fifty extracted
 * from the licensee sheet.
 */
const LOGOS: Record<PaymentLogoKey, number> = {
  "esewa": require("../../../assets/images/wallets/esewa.png"),
  "fonepay": require("../../../assets/images/wallets/fonepay.png"),
  "khalti": require("../../../assets/images/wallets/khalti.png"),
  "agricultural-development": require("../../../assets/images/banks/agricultural-development.png"),
  "citizens": require("../../../assets/images/banks/citizens.png"),
  "everest": require("../../../assets/images/banks/everest.png"),
  "global-ime": require("../../../assets/images/banks/global-ime.png"),
  "himalayan": require("../../../assets/images/banks/himalayan.png"),
  "kumari": require("../../../assets/images/banks/kumari.png"),
  "laxmi-sunrise": require("../../../assets/images/banks/laxmi-sunrise.png"),
  "machhapuchchhre": require("../../../assets/images/banks/machhapuchchhre.png"),
  "nabil": require("../../../assets/images/banks/nabil.png"),
  "nabil-ncb": require("../../../assets/images/banks/nabil-ncb.png"),
  "ncc": require("../../../assets/images/banks/ncc.png"),
  "nepal-bank": require("../../../assets/images/banks/nepal-bank.png"),
  "nepal-investment-mega": require("../../../assets/images/banks/nepal-investment-mega.png"),
  "nepal-rastra": require("../../../assets/images/banks/nepal-rastra.png"),
  "nepal-sbi": require("../../../assets/images/banks/nepal-sbi.png"),
  "nic-asia": require("../../../assets/images/banks/nic-asia.png"),
  "nmb": require("../../../assets/images/banks/nmb.png"),
  "prabhu": require("../../../assets/images/banks/prabhu.png"),
  "prime-commercial": require("../../../assets/images/banks/prime-commercial.png"),
  "sanima": require("../../../assets/images/banks/sanima.png"),
  "siddhartha": require("../../../assets/images/banks/siddhartha.png"),
  "standard-chartered": require("../../../assets/images/banks/standard-chartered.png"),
  "ambe": require("../../../assets/images/banks/ambe.png"),
  "bank-of-kathmandu": require("../../../assets/images/banks/bank-of-kathmandu.png"),
  "century-commercial": require("../../../assets/images/banks/century-commercial.png"),
  "civil": require("../../../assets/images/banks/civil.png"),
  "development-credit": require("../../../assets/images/banks/development-credit.png"),
  "garima": require("../../../assets/images/banks/garima.png"),
  "janata": require("../../../assets/images/banks/janata.png"),
  "jyoti": require("../../../assets/images/banks/jyoti.png"),
  "kamana-sewa": require("../../../assets/images/banks/kamana-sewa.png"),
  "lumbini": require("../../../assets/images/banks/lumbini.png"),
  "muktinath": require("../../../assets/images/banks/muktinath.png"),
  "national-development": require("../../../assets/images/banks/national-development.png"),
  "prabhu-mahalaxmi": require("../../../assets/images/banks/prabhu-mahalaxmi.png"),
  "shangri-la": require("../../../assets/images/banks/shangri-la.png"),
  "swbbl": require("../../../assets/images/banks/swbbl.png"),
  "asha": require("../../../assets/images/banks/asha.png"),
  "chhimek": require("../../../assets/images/banks/chhimek.png"),
  "deprosc": require("../../../assets/images/banks/deprosc.png"),
  "first-microfinance": require("../../../assets/images/banks/first-microfinance.png"),
  "forward-community": require("../../../assets/images/banks/forward-community.png"),
  "grameen-bikas": require("../../../assets/images/banks/grameen-bikas.png"),
  "infinity": require("../../../assets/images/banks/infinity.png"),
  "mithila": require("../../../assets/images/banks/mithila.png"),
  "nerude": require("../../../assets/images/banks/nerude.png"),
  "sana-kisan": require("../../../assets/images/banks/sana-kisan.png"),
  "suryodaya-womi": require("../../../assets/images/banks/suryodaya-womi.png"),
  "suva": require("../../../assets/images/banks/suva.png"),
  "womi": require("../../../assets/images/banks/womi.png"),
};

/** Whether anything the app can draw a mark for is named here. */
export function hasWalletLogo(name: string | null | undefined): boolean {
  return resolvePaymentLogoKey(name) !== null;
}


/**
 * The fallback tile's tint, for a caller whose row is also saying which way the
 * money went.
 *
 * Both statement screens draw their glyph in a tinted square — red for a debit,
 * green for a credit — so the tile carries *direction* as well as identity.
 * Swapping it for a plain muted circle on a bank or cash row would throw that
 * away on exactly the rows that have no logo to compensate. A row with a real
 * logo does not take a tone: the mark is the identity and the signed amount on
 * the right is the direction.
 *
 * Literals in a table, not `bg-${tone}-soft` — a template class never reaches
 * the compiled NativeWind stylesheet. Same reason `<Badge>`'s tones are a table.
 */
const FALLBACK_TONES = {
  danger: { background: "bg-destructive-soft", ink: "destructive" },
  neutral: { background: "bg-muted", ink: "mutedForeground" },
  success: { background: "bg-success-soft", ink: "success" },
} as const;

export function WalletMark({
  name,
  size = 40,
  square = false,
  tone = "neutral",
}: {
  /**
   * A provider enum (`ESEWA`), a method (`BANK_TRANSFER`), or a bank's name as
   * somebody typed it (`"Everest Bank Ltd."`). Anything unrecognised draws the
   * glyph, which is the correct answer — see `payment-logos.ts`.
   */
  name: string | null | undefined;
  /** The tile's edge, in points. The mark is inset from it. */
  size?: number;
  /** Rounded-square rather than a circle, for the fallback. Matches the row it replaces. */
  square?: boolean;
  tone?: keyof typeof FALLBACK_TONES;
}) {
  const { colors } = useAppTheme();

  const radius = Math.round(size * 0.28);

  const key = resolvePaymentLogoKey(name);

  if (!key) {
    const { background, ink } = FALLBACK_TONES[tone];

    return (
      <View
        className={`items-center justify-center ${background}`}
        style={{
          borderRadius: square ? radius : size / 2,
          height: size,
          width: size,
        }}
      >
        <Glyph
          color={colors[ink]}
          name={(name ? PAYMENT_FALLBACK_GLYPH[name] : undefined) ?? "wallet"}
          size={Math.round(size * 0.5)}
        />
      </View>
    );
  }

  return (
    <View
      className="items-center justify-center overflow-hidden"
      style={{
        backgroundColor: "#ffffff",
        borderColor: "rgba(0,0,0,0.08)",
        borderRadius: radius,
        borderWidth: 1,
        height: size,
        width: size,
      }}
    >
      <Image
        contentFit="contain"
        source={LOGOS[key]}
        style={{ height: size - 12, width: size - 12 }}
      />
    </View>
  );
}

/**
 * The mark and the name on one line — the pair every caller wanted.
 *
 * Exported because four screens were about to write the same flex row, and one
 * of them would have written it with the label in the wrong casing.
 */
export function WalletBadge({
  name,
  size = 28,
}: {
  name: string | null | undefined;
  size?: number;
}) {
  return (
    <View className="flex-row items-center gap-2">
      <WalletMark name={name} size={size} />
      <Text variant="label">{walletLabel(name)}</Text>
    </View>
  );
}
