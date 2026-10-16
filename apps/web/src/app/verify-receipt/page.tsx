import { BadgeCheck, SearchX, ShieldAlert } from "@/components/icons";
import type { Metadata } from "next";

import { PublicShell } from "@/app/_components/shared";
import { formatNPR } from "@/modules/finance/money";
import { verifyReceiptByCode } from "@/modules/finance/receipt.service";

/**
 * `/verify-receipt` — where a certified receipt's QR and printed code lead.
 *
 * For whoever is holding the paper: a landlord, a parent, a bank. They type or
 * scan the code and see what HostelPalika recorded. A forged receipt has a code
 * that does not exist, or borrows a real one and shows a different amount and
 * name. A plain GET form, so it works with no JavaScript and from a QR scan.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  description: "Check a HostelPalika certified receipt by its verification code.",
  // Public but personal: each result is one resident's payment.
  robots: { follow: false, index: false },
  title: "Verify a receipt",
};

type PageProps = { searchParams: Promise<{ code?: string }> };

export default async function VerifyReceiptPage({ searchParams }: PageProps) {
  const { code } = await searchParams;
  const result = code ? await verifyReceiptByCode(code) : null;

  return (
    <PublicShell>
      <div className="mx-auto max-w-xl px-4 py-12 sm:py-20">
        <h1 className="font-heading text-2xl font-semibold text-foreground">Verify a receipt</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Enter the verification code printed on a HostelPalika certified receipt. It looks
          like HP-7K2M-9QXD-4TRA.
        </p>

        <form action="/verify-receipt" className="mt-6 flex gap-2" method="get">
          <label className="sr-only" htmlFor="code">
            Verification code
          </label>
          <input
            autoCapitalize="characters"
            autoComplete="off"
            className="h-11 min-w-0 flex-1 rounded-md border border-border bg-background px-3 font-mono text-sm uppercase tracking-wider text-foreground focus-visible:outline-2 focus-visible:outline-primary"
            defaultValue={code ?? ""}
            id="code"
            name="code"
            placeholder="HP-XXXX-XXXX-XXXX"
            required
          />
          <button
            className="h-11 rounded-md bg-primary px-5 text-sm font-semibold text-primary-foreground"
            type="submit"
          >
            Check
          </button>
        </form>

        {result && !result.found ? (
          <div className="mt-6 flex gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
            <SearchX className="mt-0.5 size-5 shrink-0 text-destructive" />
            <div>
              <p className="font-semibold text-foreground">No receipt has this code</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Check the code for typos. If it is right, this receipt was not issued by
                HostelPalika.
              </p>
            </div>
          </div>
        ) : null}

        {result?.found ? (
          <div
            className={`mt-6 rounded-lg border p-4 ${
              result.voidedAt ? "border-destructive/40" : "border-success/40 bg-success/5"
            }`}
          >
            <div className="flex items-center gap-2">
              {result.voidedAt ? (
                <ShieldAlert className="size-5 text-destructive" />
              ) : (
                <BadgeCheck className="size-5 text-success" />
              )}
              <p className="font-semibold text-foreground">
                {result.voidedAt
                  ? "This receipt was cancelled"
                  : "Genuine certified receipt · Resident Offer Program"}
              </p>
            </div>

            <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              {[
                ["Amount", formatNPR(result.amount)],
                ["Resident", result.residentName],
                ["Paid to", result.hostelName],
                ["For", result.period ?? "—"],
                ["Issued", result.issuedAt.slice(0, 10)],
                ["Receipt number", result.receiptNumber],
                ["Code", result.certificationCode],
                ...(result.voidedAt ? [["Cancelled", result.voidedAt.slice(0, 10)]] : []),
              ].map(([label, value]) => (
                <div className="contents" key={label}>
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="font-medium tabular-nums text-foreground">{value}</dd>
                </div>
              ))}
            </dl>

            <p className="mt-4 text-xs text-muted-foreground">
              Compare these with the paper in front of you. If the amount or name is
              different, the paper is not this receipt.
            </p>
          </div>
        ) : null}
      </div>
    </PublicShell>
  );
}
