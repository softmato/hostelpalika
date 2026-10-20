import {
  PAYMENT_FALLBACK_GLYPH,
  resolvePaymentLogoKey,
  walletLabel,
} from "@hostel/shared/constants/payment-logos";

import { Glyph } from "@/components/glyph";
import { cn } from "@/lib/utils";

export { walletLabel };

/**
 * A payment provider or bank's own logo, in a tile — the web twin of the app's
 * `WalletMark` (`apps/mobile/src/components/ui/wallet-mark.tsx`, where the long
 * reasoning lives).
 *
 * - **Real marks.** eSewa, Khalti and Fonepay plus fifty banks, served from
 *   `/payment-logos/{key}.png`: our own files, not a remote host that could
 *   break on the one screen where someone decides whether to trust us with money.
 * - **It takes a name.** `ESEWA`, `BANK_TRANSFER` or `"Everest Bank Ltd."` as an
 *   owner typed it; `resolvePaymentLogoKey` (shared with the app) does the matching.
 * - **Always a white tile**, in both themes. Fonepay's near-black `pay` and
 *   Khalti's deep purple vanish on a dark card, and the white keeps a third
 *   party's colours inside a box that is visibly theirs, never on our chrome.
 * - **Unknown → a glyph, never a guess.** Bank transfer, cash and anything new
 *   draw a muted glyph tile; a wrong brand mark is worse than none.
 */
export function WalletMark({
  className,
  name,
  size = 40,
}: {
  className?: string;
  /** A provider enum, a method, or a bank's name as typed. */
  name: string | null | undefined;
  /** The tile's edge in px. The mark is inset from it. */
  size?: number;
}) {
  const key = resolvePaymentLogoKey(name);
  const radius = Math.round(size * 0.28);
  const label = walletLabel(name ?? null);

  if (!key) {
    return (
      <span
        aria-label={label}
        className={cn("inline-flex shrink-0 items-center justify-center bg-muted text-muted-foreground", className)}
        role="img"
        style={{ borderRadius: radius, height: size, width: size }}
      >
        <Glyph
          className="shrink-0"
          name={(name ? PAYMENT_FALLBACK_GLYPH[name] : undefined) ?? "wallet"}
          size={Math.round(size * 0.5)}
        />
      </span>
    );
  }

  return (
    <span
      className={cn("inline-flex shrink-0 items-center justify-center overflow-hidden bg-white ring-1 ring-black/[0.08]", className)}
      style={{ borderRadius: radius, height: size, width: size }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- tiny local PNGs; the optimiser buys nothing */}
      <img
        alt={label}
        className="object-contain"
        draggable={false}
        height={size - Math.round(size * 0.24)}
        src={`/payment-logos/${key}.png`}
        width={size - Math.round(size * 0.24)}
      />
    </span>
  );
}

/** The mark and its name on one line. */
export function WalletBadge({ name, size = 24 }: { name: string | null | undefined; size?: number }) {
  return (
    <span className="inline-flex items-center gap-2">
      <WalletMark name={name} size={size} />
      <span className="text-[13px] font-medium text-foreground">{walletLabel(name ?? null)}</span>
    </span>
  );
}
