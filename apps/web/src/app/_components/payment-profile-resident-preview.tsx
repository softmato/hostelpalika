"use client";

import { AlertTriangle, Building2, Copy, QrCode, Smartphone } from "lucide-react";
import { memo, type ReactNode } from "react";

import { EsewaMark, KhaltiMark } from "@/app/_components/payment-brand-marks";
import { currency } from "@/app/_components/shared-ui";

/**
 * The resident pay screen, rendered from the owner's unsaved form (item 3.1).
 *
 * This is a **mirror of `resident-pay-invoice-panel.tsx`, not a second source of
 * truth.** An owner filling this form is deciding what a resident will see, and
 * until now had to save, log out, and open a resident account to find out. The
 * two rules that decide the shape of that screen are reproduced here exactly:
 *
 * 1. method order is the server's — gateway, QR, eSewa, Khalti, bank
 *    (`buildMethods` in `pay-instructions.service.ts`);
 * 2. a wallet id is **suppressed** once that wallet's checkout is live, because
 *    "pay with eSewa" beside "transfer to this eSewa id" asks the resident to
 *    choose between two things they cannot tell apart.
 *
 * If either rule changes on the server, it has to change here — a preview that
 * lies is worse than no preview, because the owner stops checking the real one.
 *
 * The invoice itself is invented and labelled as such. A real one would need a
 * resident, and the numbers are only scaffolding for the details being edited.
 */

export type ProfileDraft = {
  bankAccountName: string;
  bankAccountNumber: string;
  bankName: string;
  cashApprovalThreshold: string;
  displayName: string;
  esewaId: string;
  khaltiId: string;
  paymentInstructions: string;
  /**
   * What the QR poster says it pays. Read off the image at upload, and typed
   * here only when that read came back empty — the resident never sees these
   * (they read the poster itself), but `evidence-payee` matches receipts
   * against them, which is what makes a QR-only hostel verifiable.
   */
  qrPayeeName: string;
  qrPayeeNumber: string;
};

/** Stand-in invoice. Round numbers so nothing here reads as real hostel data. */
const SAMPLE = {
  amount: 12_000,
  dueDate: "31 Aug 2026",
  period: "August 2026",
  referenceCode: "RUP-4821-K",
};

const PROVIDER_LABEL: Record<string, string> = {
  ESEWA: "eSewa",
  FONEPAY: "Fonepay",
  KHALTI: "Khalti",
};

function FakeCopyButton() {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[10px] font-semibold text-muted-foreground">
      <Copy aria-hidden="true" className="size-3" />
      Copy
    </span>
  );
}

function MethodShell({
  children,
  highlight,
}: {
  children: ReactNode;
  highlight?: boolean;
}) {
  return (
    <div
      className={
        highlight
          ? "rounded-lg border-2 border-role-resident/40 bg-role-resident/5 p-2.5"
          : "rounded-lg border border-border p-2.5"
      }
    >
      {children}
    </div>
  );
}

function WalletRow({
  id,
  label,
  mark,
}: {
  id: string;
  label: string;
  mark: ReactNode;
}) {
  return (
    <MethodShell>
      <p className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
        {mark}
        {label}
      </p>
      <p className="mt-1.5 flex flex-wrap items-center gap-2 font-mono text-xs font-semibold">
        {id}
        <FakeCopyButton />
      </p>
    </MethodShell>
  );
}

export type ExtraAccount = {
  accountName: string | null;
  bankName: string | null;
  kind: "BANK" | "ESEWA" | "KHALTI";
  number: string;
};

export const PaymentProfileResidentPreview = memo(
  function PaymentProfileResidentPreview({
    draft,
    enabledProviders,
    extraAccounts = [],
    staticQrAssetId,
  }: {
    draft: ProfileDraft;
    /** A second bank or wallet — shown after the profile's own ones, as the pay screen does. */
    extraAccounts?: ExtraAccount[];
    /** Providers with live checkout — these suppress the matching wallet id. */
    enabledProviders: string[];
    staticQrAssetId: string | null;
  }) {
    const live = new Set(enabledProviders.map((provider) => provider.toUpperCase()));

    const showEsewa = Boolean(draft.esewaId) && !live.has("ESEWA");
    const showKhalti = Boolean(draft.khaltiId) && !live.has("KHALTI");
    const showBank = Boolean(draft.bankAccountNumber);
    const extraWallets = extraAccounts.filter(
      (account) => account.kind !== "BANK" && !live.has(account.kind),
    );
    const extraBanks = extraAccounts.filter((account) => account.kind === "BANK");
    const hasManual =
      Boolean(staticQrAssetId) || showEsewa || showKhalti || showBank || extraAccounts.length > 0;
    const usable = hasManual || live.size > 0;

    return (
      <div className="space-y-3 rounded-xl border border-border bg-background p-3">
        <div className="flex items-center justify-between gap-2 border-b border-border pb-2">
          <p className="font-heading text-xs font-bold">How to pay</p>
          <p className="text-[10px] text-muted-foreground">Rent for {SAMPLE.period}</p>
        </div>

        <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/50 p-2.5">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Amount to pay
            </p>
            <p className="text-lg font-bold">{currency(SAMPLE.amount)}</p>
          </div>
          <div className="text-right">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Due
            </p>
            <p className="text-xs font-semibold">{SAMPLE.dueDate}</p>
          </div>
        </div>

        <div className="rounded-lg border-2 border-role-resident/40 bg-role-resident/5 p-2.5">
          <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
            Write this reference in the remarks
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <span className="font-mono text-base font-bold tracking-widest">
              {SAMPLE.referenceCode}
            </span>
            <FakeCopyButton />
          </div>
        </div>

        {usable ? (
          <>
            <p className="text-xs">
              Pay{" "}
              <span className="font-semibold">
                {draft.displayName || "your hostel"}
              </span>{" "}
              using any of these:
            </p>

            <div className="space-y-2">
              {[...live].map((provider) => (
                <MethodShell highlight key={`GATEWAY:${provider}`}>
                  <span className="flex w-full items-center justify-center gap-1.5 rounded-md bg-role-resident px-3 py-1.5 text-xs font-bold text-white">
                    <Smartphone aria-hidden="true" className="size-3.5" />
                    Pay with {PROVIDER_LABEL[provider] ?? provider}
                  </span>
                  <p className="mt-1.5 text-center text-[10px] text-muted-foreground">
                    Settles automatically — no screenshot needed.
                  </p>
                </MethodShell>
              ))}

              {staticQrAssetId ? (
                <MethodShell>
                  <div className="flex flex-col items-center gap-1.5">
                    {/* eslint-disable-next-line @next/next/no-img-element -- private asset served through our own authorizing route */}
                    <img
                      alt="Scan to pay"
                      className="size-28 object-contain"
                      src={`/api/v1/files/${staticQrAssetId}/url`}
                    />
                    <span className="flex items-center gap-1 text-[10px] font-semibold text-muted-foreground">
                      <QrCode aria-hidden="true" className="size-3" />
                      Scan with any payment app
                    </span>
                  </div>
                </MethodShell>
              ) : null}

              {showEsewa ? (
                <WalletRow
                  id={draft.esewaId}
                  label="eSewa"
                  mark={<EsewaMark className="size-4" />}
                />
              ) : null}

              {showKhalti ? (
                <WalletRow
                  id={draft.khaltiId}
                  label="Khalti"
                  mark={<KhaltiMark className="size-4" />}
                />
              ) : null}

              {extraWallets.map((account, index) => (
                <WalletRow
                  id={account.number}
                  key={`${account.kind}:${index}`}
                  label={account.kind === "ESEWA" ? "eSewa" : "Khalti"}
                  mark={
                    account.kind === "ESEWA" ? (
                      <EsewaMark className="size-4" />
                    ) : (
                      <KhaltiMark className="size-4" />
                    )
                  }
                />
              ))}

              {showBank ? (
                <MethodShell>
                  <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                    <Building2 aria-hidden="true" className="size-3" />
                    Bank transfer
                  </p>
                  <div className="mt-1.5 space-y-0.5 text-xs">
                    {draft.bankName ? (
                      <p className="font-semibold">{draft.bankName}</p>
                    ) : null}
                    {draft.bankAccountName ? (
                      <p className="text-muted-foreground">{draft.bankAccountName}</p>
                    ) : null}
                    <p className="flex flex-wrap items-center gap-2 font-mono font-semibold">
                      {draft.bankAccountNumber}
                      <FakeCopyButton />
                    </p>
                  </div>
                </MethodShell>
              ) : null}

              {extraBanks.map((account, index) => (
                <MethodShell key={`BANK:${index}`}>
                  <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                    <Building2 aria-hidden="true" className="size-3" />
                    Bank transfer
                  </p>
                  <div className="mt-1.5 space-y-0.5 text-xs">
                    {account.bankName ? <p className="font-semibold">{account.bankName}</p> : null}
                    {account.accountName ? (
                      <p className="text-muted-foreground">{account.accountName}</p>
                    ) : null}
                    <p className="flex flex-wrap items-center gap-2 font-mono font-semibold">
                      {account.number}
                      <FakeCopyButton />
                    </p>
                  </div>
                </MethodShell>
              ))}
            </div>

            {draft.paymentInstructions ? (
              <p className="whitespace-pre-line rounded-lg bg-muted/50 p-2.5 text-xs">
                {draft.paymentInstructions}
              </p>
            ) : null}

            {hasManual ? (
              <p className="text-[10px] text-muted-foreground">
                If you paid by QR, wallet or bank transfer, upload the screenshot
                below — those are confirmed by your hostel before they count.
              </p>
            ) : null}
          </>
        ) : (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-800 dark:text-amber-300">
            <p className="flex items-center gap-1.5 font-semibold">
              <AlertTriangle aria-hidden="true" className="size-3.5" />
              Your hostel has not set up online payment details yet.
            </p>
            <p className="mt-1 leading-4">
              Ask them how to pay, then upload your payment screenshot below so it
              still reaches your record.
            </p>
          </div>
        )}
      </div>
    );
  },
);
