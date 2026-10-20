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
  ReceiptText,
} from "@/components/icons";
import Link from "next/link";

import { EmptyState, LoadingRows, currency } from "@/app/_components/shared-ui";
import { Button } from "@/components/ui/button";
import { dayMonthYear, monthLabel } from "@/lib/format-month";
import { usePortalResource } from "@/lib/portal-query";
import { residentEndpoints } from "@/lib/resident-endpoints";
import { CardSkeletons, SectionTitle, titleCase } from "./daily-portal-ui";
import {
  MetricCard,
  PortalPageHeader,
  SectionCard,
  SoftBadge,
  statusToneFromLabel,
} from "./portal-dashboard-ui";
import { Message } from "./resident-shared";

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
      className="inline-flex items-center gap-2 rounded-xl border border-border bg-muted/40 px-3 py-1.5 font-mono text-[13px] font-semibold tracking-wider text-role-team transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-role-team"
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
      <div className="mx-auto max-w-[1000px] space-y-5">
        <PortalPageHeader
          actions={
            <Button asChild className="h-9 gap-2 rounded-xl" variant="outline">
              <Link href="/resident-offer-program">
                Rules
                <ArrowUpRight className="size-4" />
              </Link>
            </Button>
          }
          description="Certified payments and this quarter's offers."
          title="Offer Program"
        />
        <Message value={finance.message || programme.message} />

        {programme.state === "loading" ? (
          <CardSkeletons />
        ) : (
          <div className="grid gap-3 sm:grid-cols-3">
            <MetricCard
              icon={BadgeCheck}
              label={quarter ? `Certified · ${quarter.label}` : "Certified"}
              value={currency(quarter?.certifiedAmount ?? 0)}
            />
            <MetricCard icon={Check} label="Certified payments" value={quarter?.certifiedCount ?? 0} />
            <MetricCard icon={Gift} label="Your offers" value={awards.length} />
          </div>
        )}

        {awards.length > 0 ? (
          <section className="space-y-3">
            <SectionTitle>Your offers</SectionTitle>
            <div className="grid gap-3 sm:grid-cols-2">
              {awards.map((award) => (
                <div className="flex items-center gap-3 rounded-2xl border border-border/70 bg-card p-4" key={award.id}>
                  <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-role-team-soft text-role-team">
                    {award.kind === "FEE_OFF" ? <Percent className="size-5" /> : <Gift className="size-5" />}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate font-heading text-[15px] font-semibold text-foreground">{award.title}</p>
                    <p className="truncate text-[12.5px] text-muted-foreground">
                      {award.quarterLabel} · {awardState(award)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <section className="space-y-3">
          <SectionTitle>Perks you can get</SectionTitle>
          {programme.state === "loading" ? (
            <CardSkeletons count={2} />
          ) : perks.length === 0 ? (
            <SectionCard>
              <EmptyState label="Perks are on their way. Keep paying with your code." />
            </SectionCard>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {perks.map((perk) => (
                <article
                  className="overflow-hidden rounded-2xl border border-border/70 bg-card transition duration-200 hover:-translate-y-0.5 hover:shadow-md"
                  key={perk.id}
                >
                  <div className="relative aspect-[16/9] bg-muted">
                    {perk.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img alt="" className="size-full object-cover" src={perk.imageUrl} />
                    ) : (
                      <span className="flex size-full items-center justify-center text-role-team">
                        {perk.kind === "FEE_OFF" ? <Percent className="size-8" /> : <Gift className="size-8" />}
                      </span>
                    )}
                    <span className="absolute left-2.5 top-2.5 rounded-full bg-black/60 px-2.5 py-0.5 text-[11px] font-semibold text-white backdrop-blur">
                      {perk.kind === "FEE_OFF" ? `${perk.percentOff}% off` : "Gift"}
                    </span>
                  </div>
                  <div className="p-4">
                    <p className="font-heading text-[15px] font-semibold text-foreground">{perk.title}</p>
                    <p className="text-[12.5px] text-muted-foreground">
                      {perkTerms(perk)} · {perk.partner}
                    </p>
                    {perk.description ? (
                      <p className="mt-1 line-clamp-2 text-[13px] text-muted-foreground">{perk.description}</p>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="space-y-3">
          <SectionTitle>Your codes</SectionTitle>
          <SectionCard>
            {finance.state === "loading" ? (
              <LoadingRows />
            ) : activeCodes.length === 0 ? (
              <EmptyState label="Nothing is due, so there is no code to quote." />
            ) : (
              <div className="divide-y divide-border/60">
                {activeCodes.map((invoice) => (
                  <div className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0" key={invoice.id}>
                    <div className="min-w-0">
                      <p className="text-[13.5px] font-semibold text-foreground">{monthLabel(invoice.month)}</p>
                      <p className="text-[12px] text-muted-foreground">
                        {currency(invoice.dueAmount - invoice.paidAmount)} to pay
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <SoftBadge tone={statusToneFromLabel(invoice.status)}>{titleCase(invoice.status)}</SoftBadge>
                      <ReferenceCode code={invoice.referenceCode!} />
                    </div>
                  </div>
                ))}
                <p className="pt-3 text-[12.5px] text-muted-foreground">
                  Paste the code into the remarks when you pay. Only coded payments are certified.
                </p>
              </div>
            )}
          </SectionCard>
        </section>

        <section className="space-y-3">
          <SectionTitle>Receipts</SectionTitle>
          <SectionCard>
            {finance.state === "loading" ? (
              <LoadingRows />
            ) : receipts.length === 0 ? (
              <EmptyState label="No receipts yet. One comes each time your hostel confirms a payment." />
            ) : (
              <div className="divide-y divide-border/60">
                {receipts.map((receipt) => (
                  <div className="flex items-center gap-3 py-3 first:pt-0" key={receipt.id}>
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
                      <ReceiptText className="size-[18px]" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-[13px] font-medium text-foreground">{receipt.number}</p>
                      <p className="truncate text-[12px] text-muted-foreground">
                        {receipt.month ? monthLabel(receipt.month) : "One-off"} · {currency(receipt.amount)}
                        {receipt.issuedAt ? ` · ${dayMonthYear(receipt.issuedAt)}` : ""}
                      </p>
                    </div>
                    {receipt.certificationCode ? (
                      <span
                        className="hidden items-center gap-1 rounded-full bg-role-team-soft px-2 py-0.5 text-[11px] font-semibold text-role-team sm:inline-flex"
                        title={receipt.certificationCode}
                      >
                        <BadgeCheck className="size-3.5" />
                        Certified
                      </span>
                    ) : null}
                    <a
                      aria-label={`Download receipt ${receipt.number}`}
                      className="flex size-9 items-center justify-center rounded-xl border border-border text-foreground transition hover:bg-muted"
                      href={residentEndpoints.receiptPdf(receipt.id)}
                    >
                      <Download className="size-4" />
                    </a>
                  </div>
                ))}
                {/* A receipt is not proof of a payment: that is the bank's own confirmation. */}
                <p className="pt-3 text-[12.5px] text-muted-foreground">
                  Anyone can check a certified receipt at hostelpalika.com/verify-receipt.
                </p>
              </div>
            )}
          </SectionCard>
        </section>
      </div>
    );
  },
);
