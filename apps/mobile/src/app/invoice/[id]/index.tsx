import { LinearGradient } from "expo-linear-gradient";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import { View } from "react-native";

import {
  FLOAT_SHADOW,
  PaintedAmount,
  usePortalPaint,
} from "@/components/portal-shared";
import { ReferenceStrip } from "@/components/resident-payments";
import { AppBar } from "@/components/ui/app-bar";
import { StatusText } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Money } from "@/components/ui/money";
import { Screen } from "@/components/ui/screen";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, FailureState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { WalletMark, walletLabel } from "@/components/ui/wallet-mark";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { readApiError } from "@/lib/api-contract";
import { downloadToDevice } from "@/lib/documents";
import {
  receiptPdfUrl,
  type ResidentClaim,
  type ResidentFinanceView,
  type ResidentInvoice,
} from "@/lib/finance-api";
import { formatMoney, humanizeEnum } from "@/lib/format";
import { invoiceLedger, oneOffLabel, outstanding } from "@/lib/invoice-ledger";
import { residentQuery } from "@/lib/resident-queries";
import { toastError } from "@/lib/toast";

/**
 * One invoice, as a statement.
 *
 * ## Why this refetches the whole finance view
 *
 * There is no `GET /resident/finance/invoices/{id}`. The list endpoint is the
 * only resident-facing read, so the detail screen asks for it again and picks
 * its row out. That is one extra request rather than a second shape that can
 * drift from the list's — and the list is small (a resident's own months).
 *
 * ## One Details card, not a breakdown and a statement
 *
 * They used to be two sections that repeated the total three times between
 * them. Now it is one card: what was charged, then what was paid. The summary
 * card carries the arithmetic. See `DetailsCard`.
 *
 * The breakdown was blocked server-side until 2026-08-17: `Invoice.lines` had
 * always existed and `toPortalInvoice()` dropped it, so a resident could see
 * what they owed and never why.
 *
 * ## The identity is painted; the money is not
 *
 * The bar was `<AppBar accent>` — the whole strip painted, carrying the month as
 * its title — with a white summary card pulled up onto it. That put the month in
 * the same 44-point row as the back chevron, at the same size the tab bar writes
 * "Payments", which is not the treatment the *subject of the screen* deserves.
 *
 * It is two objects now. The bar is plain and says only `Invoice detail`, which
 * is what a pushed screen's bar is for. Under it sits a **painted block**
 * carrying the month large, its due date, and the status — the invoice's
 * identity — and the summary card straddles *that* block's bottom edge rather
 * than the bar's. `NOTES.md` §1: an accent header is a block with rounded bottom
 * corners with something sitting half on the colour and half on the page below.
 * A pushed screen gets to have both a bar and a header; conflating them is what
 * made the month look like a breadcrumb.
 *
 * ## The summary is a four-fact ledger, not one big number
 *
 * It showed `Still owed` in display type with a status pill beside it. That is
 * the right lead for the *pay* screen, where the only question is how much to
 * transfer. Here the question is arithmetic — a resident opening an invoice
 * after a part payment wants to see the subtraction — so the card carries
 * **total due** and **paid** as a two-up, and the outstanding figure under a
 * rule as the result. Three numbers that add up beat one number that has to be
 * taken on trust.
 *
 * ## The reference code is `<ReferenceStrip>`, shared with the pay screen
 *
 * It used to be a card of its own here: the code in 24-point tracked type, a
 * sentence under it, and then a `Copy reference` **`<ListRow>`** — a list row
 * standing in for a button, under a value that looked like a heading. One code,
 * one object, one gesture; the component's own note has the rest.
 */

/**
 * How far the summary card is pulled up onto the painted block, in points.
 *
 * Shared with `pay.tsx` and `claim.tsx`, which straddle their own blocks by the
 * same amount — the three screens are one flow, and a step that changes its
 * chrome reads as a different app.
 */
const STRADDLE = 26;

export default function InvoiceDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const query = residentQuery.finance();
  const finance = useResource<ResidentFinanceView>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  const invoice = finance.data?.invoices.find((row) => row.id === id) ?? null;

  const header = <AppBar showBack title="Invoice detail" />;

  if (finance.loading) {
    return (
      /*
        The painted block with its straddling card, then the breakdown and the
        statement — the shape this screen lands in, drawn at the size it lands
        at. It replaced a centred spinner, which is the one thing `CLAUDE.md`
        and `NOTES.md` §9 are both explicit about: loading is skeletons.
      */
      <Screen header={header} padded={false} scroll>
        <View className="px-5">
          <Skeleton height={104} radius={20} />
        </View>

        <View className="px-5" style={{ marginTop: -STRADDLE }}>
          <Skeleton height={158} radius={18} />
        </View>

        <View className="gap-5 px-5 pt-6">
          <View className="gap-3">
            <Skeleton height={18} width="45%" />
            <Skeleton height={120} radius={16} />
          </View>
        </View>
      </Screen>
    );
  }

  if (finance.error) {
    return (
      <Screen header={header}>
        <FailureState
          message={finance.error}
          onRetry={finance.reload}
          title="Couldn't load this invoice"
        />
      </Screen>
    );
  }

  if (!invoice) {
    return (
      <Screen header={header}>
        <EmptyState
          action={<Button label="Go back" onPress={() => router.back()} variant="outline" />}
          description="This invoice does not exist or has been removed."
          icon="document"
          title="Invoice not found"
        />
      </Screen>
    );
  }

  const owed = outstanding(invoice);
  const claims = (finance.data?.claims ?? []).filter(
    (claim) => claim.invoiceId === invoice.id,
  );

  return (
    <Screen
      /*
       * Both actions are a sticky footer, not cards in the scroll.
       *
       * A resident opening an unpaid invoice came to settle it, and the
       * breakdown, the statement and the receipts below can run to twenty rows
       * — a button at the end of that is a button most of them never reach.
       * They disappear once nothing is owed rather than greying out: "pay" on a
       * settled month is a question, not a disabled control.
       *
       * The pair matches the Payments tab's, at the same widths and in the same
       * order, because they settle the same invoice and a resident should not
       * have to re-find them one screen deeper.
       */
      footer={
        owed > 0 ? (
          <View className="flex-row gap-3">
            <View className="flex-1">
              <Button label="Pay now" onPress={() => router.push(`/invoice/${id}/pay`)} />
            </View>
            <View className="flex-1">
              <Button
                label="I've paid"
                onPress={() => router.push(`/invoice/${id}/claim`)}
                variant="outline"
              />
            </View>
          </View>
        ) : undefined
      }
      header={header}
      onRefresh={finance.refresh}
      padded={false}
      refreshing={finance.refreshing}
      scroll
    >
      <InvoiceHeaderBlock invoice={invoice} />

      <SummaryCard invoice={invoice} owed={owed} />

      <View className="gap-5 px-5 pt-6">
        <DetailsCard invoice={invoice} />

        {claims.length > 0 ? <ClaimsCard claims={claims} /> : null}

        <ReceiptsCard invoice={invoice} />
      </View>

      {/* Room for the straddling card under the last section, above the footer. */}
      <View style={{ height: 8 }} />
    </Screen>
  );
}

/**
 * The invoice's identity, painted.
 *
 * The month is the subject of this screen, so it is set at display size on the
 * accent with the due date under it and the status on its shoulder — the "hero
 * is an account card" shape from `NOTES.md` §2, reduced to the three facts that
 * identify one bill.
 *
 * Cornered only at the bottom and bled to the page edges: this is a *header*,
 * not a card. A block that is rounded on all four sides and inset from the
 * margins would be a second card above the summary card, which is exactly the
 * "two stacked cards saying overlapping things" the Payments tab was rebuilt to
 * stop doing.
 *
 * Bottom padding is `STRADDLE` plus the card's own inset, because the card is
 * about to be pulled back up over it — without it the paint ends where the card
 * begins and the straddle has nothing to straddle.
 */
function InvoiceHeaderBlock({ invoice }: { invoice: ResidentInvoice }) {
  const dates = useDates();
  const paint = usePortalPaint();

  return (
    <LinearGradient
      colors={[paint.from, paint.to]}
      end={{ x: 1, y: 1 }}
      start={{ x: 0, y: 0 }}
      style={{
        borderBottomLeftRadius: 24,
        borderBottomRightRadius: 24,
        overflow: "hidden",
      }}
    >
      <View className="absolute inset-0" style={{ pointerEvents: "none" }}>
        <View
          className="absolute rounded-full bg-white/10"
          style={{ height: 140, right: -50, top: -70, width: 140 }}
        />
      </View>

      <View
        className="gap-1.5 px-5 pt-4"
        style={{ paddingBottom: STRADDLE + 14 }}
      >
        <PaintedAmount
          size={26}
          value={oneOffLabel(invoice) ?? dates.period(invoice.month)}
        />

        <Text
          numberOfLines={1}
          style={{ color: "rgba(255,255,255,0.78)", fontSize: 12 }}
        >
          {invoice.dueDate ? dates.dateBoth(invoice.dueDate) : "No due date recorded"}
        </Text>

        {/*
          A white pill with the status in it, rather than `<StatusPill>`: that
          component's tones are themed tokens, and `text-warning` on paint
          resolves to a colour chosen to sit on the page background. On the
          accent it is either invisible or wrong. The ink is a literal for the
          reason `<PaintPill>` documents.
        */}
        <View className="mt-1 self-start rounded-full bg-white/95 px-2.5 py-1">
          <Text
            className="font-bold uppercase tracking-wider"
            style={{ color: STATUS_ON_PAINT[invoice.status] ?? "#1f2937", fontSize: 10 }}
          >
            {humanizeEnum(invoice.status)}
          </Text>
        </View>
      </View>
    </LinearGradient>
  );
}

/**
 * Status ink for a pill sitting on the accent.
 *
 * The light-mode values of `--destructive`, `--warning` and `--success`, copied
 * rather than read: the pill is white in both schemes, so reading the themed
 * token would give the dark-mode colour on a surface that never goes dark. Same
 * trade `<PaintPill>` makes, same reason. An unmapped status falls through to a
 * near-black, which is correct rather than confidently wrong.
 */
const STATUS_ON_PAINT: Record<string, string> = {
  CANCELLED: "#4b5563",
  OPEN: "#b45309",
  OVERDUE: "#b91c1c",
  PAID: "#0a8a4b",
  PARTIAL: "#b45309",
  PENDING_PROOF: "#b45309",
  UNPAID: "#b45309",
};

/**
 * The arithmetic, straddling the painted block.
 *
 * Total due and paid as a two-up, their difference under a rule, and the code to
 * quote below that. Everything a resident needs before deciding whether to tap
 * `Pay now`; the sections underneath are the *explanation*, which is a different
 * job and is why each of them is separated from this by a heading.
 *
 * A themed card on paint rather than more paint: the block above is already the
 * accent, and a coloured card on a coloured block has no edge. `bg-card` gives
 * it one in both schemes, and `FLOAT_SHADOW` carries both halves — `elevation`
 * is the only thing Android draws and the `shadow*` trio is the only thing iOS
 * reads, and a card overlapping paint with no shadow reads as a hole cut in it.
 */
function SummaryCard({ invoice, owed }: { invoice: ResidentInvoice; owed: number }) {
  return (
    <View className="px-5" style={{ marginTop: -STRADDLE }}>
      <View
        className="gap-3 rounded-[18px] border border-border bg-card p-4"
        style={FLOAT_SHADOW}
      >
        <View className="flex-row items-start gap-3">
          <View className="flex-1 gap-0.5">
            <Text variant="caption">Total due</Text>
            <Text variant="label">{formatMoney(invoice.dueAmount)}</Text>
          </View>

          <View className="h-8 w-px bg-border" />

          <View className="flex-1 gap-0.5">
            <Text variant="caption">Paid</Text>
            <Text variant="label">{formatMoney(invoice.paidAmount)}</Text>
          </View>
        </View>

        <View className="gap-0.5 border-t border-border pt-3">
          <Text variant="caption">{owed > 0 ? "Outstanding" : "Settled"}</Text>
          <Money owed size="large" value={owed} />
        </View>

        {/*
          Only while something is owed. A settled invoice's reference code is a
          code for a transfer nobody is going to make, and putting it on the card
          keeps a call to action alive on a month that is finished — the same
          reason the Payments card drops its actions once there is nothing open.
        */}
        {owed > 0 ? (
          <ReferenceStrip code={invoice.referenceCode} hint="Reference code" />
        ) : null}
      </View>
    </View>
  );
}

/**
 * What was charged and what was paid, as one short list.
 *
 * Replaces a separate Breakdown and Statement, which repeated the same total
 * three times on one screen. The summary card above already carries due, paid
 * and outstanding, so this card has no footer — just the rows.
 *
 * Line descriptions drop their "— Bhadra 2083 BS" suffix: the header already
 * names the month. A proration basis stays, because it is what makes a part
 * month's odd amount make sense. Migrated invoices with no lines fall back to
 * the ledger's single "Amount billed" row.
 */
function DetailsCard({ invoice }: { invoice: ResidentInvoice }) {
  const dates = useDates();
  const ledger = invoiceLedger(invoice);

  const rows = [
    ...(invoice.lines.length > 0
      ? invoice.lines.map((line) => ({
          amount: line.amount,
          caption: line.prorationBasis?.split("·").pop()?.trim() ?? null,
          label: line.description.replace(/\s[—–-]\s.*$/, ""),
        }))
      : ledger
          .filter((line) => line.kind === "charge")
          .map((line) => ({ amount: line.amount, caption: null, label: line.label }))),
    ...ledger
      .filter((line) => line.kind !== "charge")
      .map((line) => ({
        amount: line.amount,
        caption: line.date ? dates.date(line.date) : null,
        label: line.kind === "receipt" ? "Paid" : line.label,
      })),
  ];

  return (
    <View>
      <SectionHeader title="Details" />

      <Card padding="px-4 py-1">
        {rows.map((row, index) => (
          <View key={`${row.label}-${index}`}>
            {index > 0 ? <RowDivider /> : null}
            <View className="min-h-14 flex-row items-center gap-3 py-3">
              <View className="flex-1 gap-0.5">
                <Text numberOfLines={1} variant="label">
                  {row.label}
                </Text>
                {row.caption ? <Text variant="caption">{row.caption}</Text> : null}
              </View>

              <Text
                className={row.amount < 0 ? "text-success" : "text-foreground"}
                variant="label"
              >
                {`${row.amount < 0 ? "−" : ""}${formatMoney(Math.abs(row.amount))}`}
              </Text>
            </View>
          </View>
        ))}
      </Card>
    </View>
  );
}

function ClaimsCard({ claims }: { claims: ResidentClaim[] }) {
  const dates = useDates();

  return (
    <View>
      <SectionHeader
        subtitle="What you told the hostel you have paid"
        title="Your claims"
      />
      <Card padding="px-4 py-1">
        {claims.map((claim, index) => (
          <View key={claim.eventId}>
            {index > 0 ? <RowDivider /> : null}
            <ListRow
              left={<WalletMark name={claim.method} size={36} />}
              right={<StatusText status={claim.status} />}
              subtitle={
                [
                  walletLabel(claim.method),
                  claim.occurredAt ? dates.dateBoth(claim.occurredAt) : null,
                ]
                  .filter(Boolean)
                  .join(" · ")
              }
              title={formatMoney(claim.amount)}
            />

            {/*
              The reason, when there is one. See the Payments tab's `ClaimRow`:
              the server has sent this since the review queue was built and no
              client read it, so a rejected resident saw a red word and no
              instruction.
            */}
            {claim.status === "REJECTED" && claim.rejectionReason ? (
              <View className="pb-3 pl-12">
                <Text className="text-destructive" variant="caption">
                  {claim.rejectionReason}
                </Text>
              </View>
            ) : null}
          </View>
        ))}
      </Card>
    </View>
  );
}

/**
 * The receipts for this month, and the sentence that explains their absence.
 *
 * Always drawn, which it was not: the section only appeared once a receipt
 * existed, so an unpaid invoice gave a resident no indication that a receipt is
 * a thing this product will eventually hand them. A named empty state is the
 * cheaper answer to "where is my receipt" than the support message that follows
 * from a screen that never mentions receipts at all.
 *
 * Voided receipts are already excluded by the server — a receipt voided with a
 * reversed payment must not stay downloadable, or the resident keeps a document
 * asserting a payment the ledger no longer counts.
 *
 * Tapping one downloads it with the bearer token and **saves it to the device**.
 * A resident who needs proof of rent for a visa or a landlord should be one tap
 * from the PDF rather than emailing the hostel for it — and what those people
 * ask for is a file to attach, which is a saved document rather than a share
 * sheet that has to be re-opened later.
 */
function ReceiptsCard({ invoice }: { invoice: ResidentInvoice }) {
  const dates = useDates();

  const [busyId, setBusyId] = useState<string | null>(null);

  const save = useCallback(async (receipt: ResidentInvoice["receipts"][number]) => {
    setBusyId(receipt.id);

    try {
      await downloadToDevice({
        extension: "pdf",
        fileName: `receipt-${receipt.number}`,
        label: `Receipt ${receipt.number}`,
        mimeType: "application/pdf",
        url: receiptPdfUrl(receipt.id),
      });
    } catch (caught) {
      toastError("Could not open the receipt", readApiError(caught));
    } finally {
      setBusyId(null);
    }
  }, []);

  return (
    <View>
      <SectionHeader title="Receipts" />

      {invoice.receipts.length === 0 ? (
        <Card>
          <EmptyState
            compact
            description="Once a payment is matched, receipts will appear here."
            title="No receipts yet"
          />
        </Card>
      ) : (
        <Card padding="px-4 py-1">
          {invoice.receipts.map((receipt, index) => (
            <View key={receipt.id}>
              {index > 0 ? <RowDivider /> : null}
              <ListRow
                busy={busyId === receipt.id}
                icon="download"
                onPress={() => void save(receipt)}
                subtitle={
                  [
                    formatMoney(receipt.amount),
                    receipt.issuedAt ? dates.date(receipt.issuedAt) : null,
                  ]
                    .filter(Boolean)
                    .join(" · ") || undefined
                }
                title={receipt.number}
              />
            </View>
          ))}
        </Card>
      )}
    </View>
  );
}
