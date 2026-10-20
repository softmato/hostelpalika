import { WalletMark } from "@/components/wallet-mark";

/**
 * Provider marks for the payment method pickers — the real eSewa, Khalti and
 * Fonepay logos (`components/wallet-mark.tsx`), and a glyph tile for the
 * categories that have no institution behind them (QR, bank, notes).
 *
 * These used to be hand-drawn lookalikes of the eSewa and Khalti marks. A
 * resident recognises their wallet by its real logo, and a near-miss copy on
 * the one screen about money reads as off. Brand colours stay inside the white
 * tile `WalletMark` draws: third-party identity, never our chrome.
 */

type MarkProps = { className?: string };

/**
 * Callers size these with a Tailwind `size-N` class; the tile needs pixels.
 * `size-10` → 40. Anything else falls back to 36, the old default.
 */
function px(className: string | undefined, fallback = 36) {
  const match = className?.match(/(?:^|\s)size-(\d+(?:\.\d+)?)(?:\s|$)/);

  return match ? Math.round(Number(match[1]) * 4) : fallback;
}

export function EsewaMark({ className }: MarkProps) {
  return <WalletMark name="ESEWA" size={px(className)} />;
}

export function KhaltiMark({ className }: MarkProps) {
  return <WalletMark name="KHALTI" size={px(className)} />;
}

export function FonepayMark({ className }: MarkProps) {
  return <WalletMark name="FONEPAY" size={px(className)} />;
}

export function QrMark({ className }: MarkProps) {
  return <WalletMark name="QR" size={px(className)} />;
}

/** A bank, or a named one: `"Nabil Bank"` draws Nabil's mark. */
export function BankMark({ className, name = "BANK" }: MarkProps & { name?: string | null }) {
  return <WalletMark name={name || "BANK"} size={px(className)} />;
}

export function NotesMark({ className }: MarkProps) {
  return <WalletMark name="OTHER" size={px(className)} />;
}
