import { Building2, FileText, QrCode, type IconComponent } from "@/components/icons";

/**
 * Provider marks for the payment method pickers.
 *
 * These are drawn inline rather than loaded as files for the same reason every
 * other icon in the portal is: a payment screen that renders its bank logos from
 * a remote host shows a broken image the day that host changes, and on the one
 * screen where a resident is deciding whether to trust us with money.
 *
 * **Brand colours are deliberate here and only here.** The house rule is that
 * everything uses the role and brand tokens — but eSewa green and Khalti purple
 * are how a Nepali resident recognises their wallet at a glance, and recolouring
 * them to our green would make the two indistinguishable from each other. They
 * are third-party identity, not our chrome.
 */

const ESEWA_GREEN = "#60BB46";
const KHALTI_PURPLE = "#5C2D91";

type MarkProps = { className?: string };

export function EsewaMark({ className = "size-9" }: MarkProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      role="img"
      viewBox="0 0 40 40"
    >
      <rect fill={ESEWA_GREEN} height="40" rx="10" width="40" />
      <path
        d="M13 21.4h13.2c.3-4.6-2.5-7.9-6.4-7.9-3.9 0-6.9 3.1-6.9 7.4 0 4.4 3 7.3 7.2 7.3 2.4 0 4.4-.9 5.7-2.4"
        stroke="#fff"
        strokeLinecap="round"
        strokeWidth="3.1"
      />
    </svg>
  );
}

export function KhaltiMark({ className = "size-9" }: MarkProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      role="img"
      viewBox="0 0 40 40"
    >
      <rect fill={KHALTI_PURPLE} height="40" rx="10" width="40" />
      <path
        d="M14.5 11v18M14.5 20.4l8.2-7.6M17.6 22.6 25.5 29"
        stroke="#fff"
        strokeLinecap="round"
        strokeWidth="3.1"
      />
    </svg>
  );
}

/** A neutral tile so the QR and bank cards sit at the same weight as the wallets. */
function NeutralMark({ className = "size-9", icon: Icon }: MarkProps & { icon: IconComponent }) {
  return (
    <span
      className={`inline-flex items-center justify-center rounded-[10px] border border-border bg-muted text-foreground ${className}`}
    >
      <Icon aria-hidden="true" className="size-1/2" />
    </span>
  );
}

export function QrMark({ className }: MarkProps) {
  return <NeutralMark className={className} icon={QrCode} />;
}

export function BankMark({ className }: MarkProps) {
  return <NeutralMark className={className} icon={Building2} />;
}

export function NotesMark({ className }: MarkProps) {
  return <NeutralMark className={className} icon={FileText} />;
}
