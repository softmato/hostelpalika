"use client";

import React, { useCallback, useMemo, useState } from "react";
import {
  ArrowUpRight,
  BadgeCheck,
  Check,
  Copy,
  Download,
  Gift,
  Percent,
  Sparkles,
} from "@/components/icons";
import Link from "next/link";

import {
  EmptyState,
  LoadingRows,
  Panel,
  StatusBadge,
  currency,
} from "@/app/_components/shared-ui";
import { usePortalResource } from "@/lib/portal-query";
import { residentEndpoints } from "@/lib/resident-endpoints";
import { Message, PageHeader } from "./portal-shared";

/**
 * The resident's own view of the Resident Offer Program.
 *
 * Two reads: the payments payload for codes and receipts (so this page and Fees
 * & Payments can never disagree about the same money), and the programme's own
 * endpoint for what only it knows — this quarter's certified total, the perks,
 * and the offers the resident has been given.
 */

type Receipt = {
  amount: number;
  certificationCode: string | null;
  id: string;
  issuedAt: string | null;
  number: string;
};

type Invoice = {
  dueAmount: number;
  id: string;
  month: string;
  paidAmount: number;
  receipts: Receipt[];
  referenceCode: string | null;
  status: string;
};

type FinanceView = { invoices: Invoice[] };

type Perk = {
  description: string;
  giftValue: number | null;
  id: string;
  imageUrl: string;
  kind: "FEE_OFF" | "GIFT";
  partner: string;
  percentOff: number | null;
  title: string;
};

type Award = {
  appliedAmount: number | null;
  appliedPeriod: string | null;
  id: string;
  kind: "FEE_OFF" | "GIFT";
  percentOff: number | null;
  quarterLabel: string;
  status: "AWARDED" | "APPLIED" | "DELIVERED" | "CANCELLED";
  title: string;
};

type Programme = {
  awards: Award[];
  perks: Perk[];
  quarter: { certifiedAmount: number; certifiedCount: number; label: string };
};

/** Months whose code is still worth quoting — the five statuses that still owe. */
const OPEN_STATUSES = new Set(["UNPAID", "OPEN", "PARTIAL", "OVERDUE", "PENDING_PROOF"]);

function perkTerms(perk: { kind: string; percentOff: number | null }) {
  return perk.kind === "FEE_OFF" ? `${perk.percentOff}% off your next monthly fee` : "Gift";
}

function awardState(award: Award) {
  if (award.status === "APPLIED") {
    return `${currency(award.appliedAmount ?? 0)} paid on your ${award.appliedPeriod ?? "bill"}`;
  }

  if (award.status === "DELIVERED") {
    return "Delivered";
  }

  return award.kind === "FEE_OFF" ? "Comes off your next monthly fee" : "Our team will contact you";
}

/**
 * A reference code with a copy button — it goes into a bank's remarks field on
 * the same phone, and retyping it by eye is how a code ends up not validating.
 */
function ReferenceCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }, [code]);

  return (
    <button
      className="inline-flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-sm font-semibold tracking-wider text-role-resident transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-role-resident"
      onClick={handleCopy}
      type="button"
    >
      {code}
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      <span className="sr-only">{copied ? "Copied" : "Copy reference code"}</span>
    </button>
  );
}

export const ResidentOfferProgramPageContent = React.memo(
  function ResidentOfferProgramPageContent() {
    const finance = usePortalResource<FinanceView>(residentEndpoints.payments, {
      errorMessage: "Could not load your receipts.",
    });
    const programme = usePortalResource<Programme>(residentEndpoints.offerProgram, {
      errorMessage: "Could not load your Offer Program.",
    });

    const invoices = useMemo(() => finance.data?.invoices ?? [], [finance.data]);

    const activeCodes = useMemo(
      () => invoices.filter((invoice) => invoice.referenceCode && OPEN_STATUSES.has(invoice.status)),
      [invoices],
    );

    const receipts = useMemo(
      () =>
        invoices
          .flatMap((invoice) => invoice.receipts.map((receipt) => ({ ...receipt, month: invoice.month })))
          .sort((a, b) => ((a.issuedAt ?? "") < (b.issuedAt ?? "") ? 1 : -1)),
      [invoices],
    );

    const quarter = programme.data?.quarter;
    const awards = programme.data?.awards ?? [];
    const perks = programme.data?.perks ?? [];

    return (
      <div className="mx-auto max-w-[900px] space-y-6">
        <PageHeader
          description="Certified payments and this quarter's offers."
          icon={Sparkles}
          title="Resident Offer Program"
        />
        <Message value={finance.message || programme.message} />

        <Panel
          action={
            <Link
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-xs font-medium text-foreground transition hover:bg-muted"
              href="/resident-offer-program"
            >
              Programme rules
              <ArrowUpRight className="size-3.5" />
            </Link>
          }
          title={quarter ? `This quarter · ${quarter.label}` : "This quarter"}
        >
          {programme.state === "loading" ? (
            <LoadingRows />
          ) : (
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-role-resident/10">
                <BadgeCheck className="size-4.5 text-role-resident" />
              </span>
              <div>
                <p className="text-2xl font-semibold tabular-nums text-foreground">
                  {currency(quarter?.certifiedAmount ?? 0)}
                </p>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {quarter?.certifiedCount === 1
                    ? "1 certified payment this quarter"
                    : `${quarter?.certifiedCount ?? 0} certified payments this quarter`}
                </p>
              </div>
            </div>
          )}
        </Panel>

        {awards.length > 0 ? (
          <Panel title="Your offers">
            <div className="space-y-2">
              {awards.map((award) => (
                <div className="flex items-center gap-3 rounded-lg border border-border p-3" key={award.id}>
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-role-resident/10">
                    {award.kind === "FEE_OFF" ? (
                      <Percent className="size-4 text-role-resident" />
                    ) : (
                      <Gift className="size-4 text-role-resident" />
                    )}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate font-medium text-foreground">{award.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {award.quarterLabel} · {awardState(award)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        ) : null}

        <Panel title="Perks you can get">
          {programme.state === "loading" ? (
            <LoadingRows />
          ) : perks.length === 0 ? (
            <EmptyState label="Perks are on their way. Keep paying with your code." />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {perks.map((perk) => (
                <div className="flex gap-3 rounded-lg border border-border p-3" key={perk.id}>
                  {perk.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img alt="" className="size-12 shrink-0 rounded-lg object-cover" src={perk.imageUrl} />
                  ) : (
                    <span className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-role-resident/10">
                      {perk.kind === "FEE_OFF" ? (
                        <Percent className="size-5 text-role-resident" />
                      ) : (
                        <Gift className="size-5 text-role-resident" />
                      )}
                    </span>
                  )}
                  <div className="min-w-0">
                    <p className="font-medium text-foreground">{perk.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {perkTerms(perk)} · from {perk.partner}
                    </p>
                    {perk.description ? (
                      <p className="mt-1 text-xs text-muted-foreground">{perk.description}</p>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Your active reference codes">
          {finance.state === "loading" ? (
            <LoadingRows />
          ) : activeCodes.length === 0 ? (
            <EmptyState label="Nothing is due right now, so there is no code to quote." />
          ) : (
            <div className="space-y-3">
              {activeCodes.map((invoice) => (
                <div
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"
                  key={invoice.id}
                >
                  <div>
                    <p className="text-sm font-medium text-foreground">{invoice.month}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {currency(invoice.dueAmount - invoice.paidAmount)} outstanding
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge>{invoice.status}</StatusBadge>
                    <ReferenceCode code={invoice.referenceCode!} />
                  </div>
                </div>
              ))}
              <p className="text-xs text-muted-foreground">
                Paste the code into the remarks or purpose field when you transfer. Only
                payments with the code are certified.
              </p>
            </div>
          )}
        </Panel>

        <Panel title="Your receipts">
          {finance.state === "loading" ? (
            <LoadingRows />
          ) : receipts.length === 0 ? (
            <EmptyState label="No receipts yet. One is issued each time your hostel verifies a payment." />
          ) : (
            <div className="space-y-2">
              {receipts.map((receipt) => (
                <div
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"
                  key={receipt.id}
                >
                  <div className="min-w-0">
                    <p className="truncate font-mono text-sm font-medium text-foreground">{receipt.number}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {receipt.month ?? "One-off"} · {currency(receipt.amount)}
                      {receipt.issuedAt ? ` · issued ${receipt.issuedAt.slice(0, 10)}` : ""}
                    </p>
                    {receipt.certificationCode ? (
                      <p className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-role-resident">
                        <BadgeCheck className="size-3.5" />
                        Certified · {receipt.certificationCode}
                      </p>
                    ) : null}
                  </div>
                  <a
                    className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-xs font-medium text-foreground transition hover:bg-muted"
                    href={residentEndpoints.receiptPdf(receipt.id)}
                  >
                    <Download className="size-3.5" />
                    PDF
                  </a>
                </div>
              ))}
              <p className="text-xs text-muted-foreground">
                Anyone can check a certified receipt at hostelpalika.com/verify-receipt. A
                receipt cannot be uploaded back as proof of a payment — for that, use the
                confirmation from the app or bank you paid with.
              </p>
            </div>
          )}
        </Panel>
      </div>
    );
  },
);
