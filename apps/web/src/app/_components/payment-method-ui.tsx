"use client";

import { AlertTriangle, Building2, Check, Copy, QrCode, Smartphone } from "lucide-react";
import { useCallback, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * The pieces of "how to pay this hostel" that are the same wherever it is shown.
 *
 * There are now three screens that print a hostel's payment details: the
 * resident's own checkout (`resident-pay-invoice-panel`), the owner's preview of
 * it while editing the profile (`payment-profile-resident-preview`), and the
 * intake desk's registration summary (`resident-registered-summary`), where a
 * warden reads the reference code out to somebody standing in front of them.
 *
 * A second hand-rolled account-number row on any of them is a place where the
 * copy button silently stops working, or a bank name goes missing, on one screen
 * and not the others. So the row, the copy button and the manual-method body live
 * here once and every screen renders the same thing.
 *
 * **Gateway checkouts are deliberately not here.** Starting one creates a payment
 * intent against the resident's own session and hands their browser to the
 * provider; it belongs to the resident's screen and nowhere else. What this file
 * covers is the manual half — QR, wallet id, bank account — which is the half
 * anybody may read out.
 */

export type GatewayProviderName = "ESEWA" | "FONEPAY" | "KHALTI";

export type PayMethod =
  /** A live checkout. Tapping it creates an intent and hands off to the provider. */
  | { kind: "GATEWAY"; provider: GatewayProviderName; sandbox: boolean }
  | {
      kind: "BANK";
      accountName: string | null;
      accountNumber: string;
      bankName: string | null;
    }
  | { kind: "ESEWA"; id: string }
  | { kind: "KHALTI"; id: string }
  | { kind: "QR"; assetId: string; notice: string | null };

export const PROVIDER_LABEL: Record<GatewayProviderName, string> = {
  ESEWA: "eSewa",
  FONEPAY: "Fonepay",
  KHALTI: "Khalti",
};

/** A stable identity for a method, used as both React key and selection value. */
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
      return "Scan QR";
    case "ESEWA":
      return "eSewa";
    default:
      return "Khalti";
  }
}

export function MethodIcon({ method }: { method: PayMethod }) {
  if (method.kind === "BANK") {
    return <Building2 aria-hidden className="size-4 shrink-0" />;
  }

  if (method.kind === "QR") {
    return <QrCode aria-hidden className="size-4 shrink-0" />;
  }

  return <Smartphone aria-hidden className="size-4 shrink-0" />;
}

export function CopyButton({
  label,
  size = "sm",
  value,
}: {
  label: string;
  size?: "lg" | "sm";
  value: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    // `writeText` rejects on an insecure origin and in some in-app browsers.
    // Failing silently would leave the resident tapping a button that appears
    // to do nothing, so the label simply does not flip.
    void navigator.clipboard
      ?.writeText(value)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => setCopied(false));
  }, [value]);

  return (
    <button
      aria-label={`Copy ${label}`}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-lg border font-semibold transition",
        copied
          ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : "border-border hover:bg-muted",
        size === "lg" ? "px-3 py-2 text-[12.5px]" : "px-2.5 py-1.5 text-xs",
      )}
      onClick={copy}
      type="button"
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export function DetailLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2.5">
      <div className="min-w-0">
        <p className="text-[10.5px] font-bold uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <p className="truncate font-mono text-sm font-semibold text-foreground">
          {value}
        </p>
      </div>
      <CopyButton label={label} value={value} />
    </div>
  );
}

/**
 * One manual method's details — everything except a live checkout.
 *
 * Handed a `GATEWAY` it renders nothing, so a caller can map over the server's
 * whole ordered list without first filtering it. That is deliberate: the order
 * the server returns is the order a resident should see, and a caller that
 * filtered it themselves would eventually filter it differently.
 */
export function ManualMethodPanel({ method }: { method: PayMethod }) {
  if (method.kind === "GATEWAY") {
    return null;
  }

  if (method.kind === "QR") {
    return (
      <div className="space-y-3">
        <div className="flex flex-col items-center gap-2 rounded-xl border border-border bg-card p-4">
          {/* eslint-disable-next-line @next/next/no-img-element -- private asset served through our own authorizing route */}
          <img
            alt="Scan to pay"
            className="size-52 max-w-full object-contain"
            src={`/api/v1/files/${method.assetId}/url`}
          />
          <span className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
            <QrCode aria-hidden className="size-3.5" />
            Scan with any payment app
          </span>
        </div>
        {/* A personal wallet's daily cap. Told before they try, because the
            network's rejection afterwards explains nothing. */}
        {method.notice ? (
          <p className="flex items-start gap-1.5 rounded-lg bg-amber-500/15 p-2.5 text-xs font-semibold leading-4 text-amber-800 dark:text-amber-300">
            <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            {method.notice}
          </p>
        ) : null}
      </div>
    );
  }

  if (method.kind === "BANK") {
    return (
      <div className="space-y-2">
        {method.bankName ? (
          <p className="text-sm font-bold text-foreground">{method.bankName}</p>
        ) : null}
        {method.accountName ? (
          <DetailLine label="Account name" value={method.accountName} />
        ) : null}
        <DetailLine label="Account number" value={method.accountNumber} />
      </div>
    );
  }

  return (
    <DetailLine
      label={method.kind === "ESEWA" ? "eSewa ID" : "Khalti ID"}
      value={method.id}
    />
  );
}
