import { router } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { View } from "react-native";

import { NotificationBell } from "@/components/notification-bell";
import { ResidentDuesCard } from "@/components/resident-payments";
import { AppBar } from "@/components/ui/app-bar";
import { StatusText } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader, SectionLink } from "@/components/ui/card";
import { IconButton } from "@/components/ui/icon-button";
import { CardRow, ListRow, RowDivider } from "@/components/ui/list-row";
import { WalletMark, walletLabel } from "@/components/ui/wallet-mark";
import { Money } from "@/components/ui/money";
import { Screen } from "@/components/ui/screen";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton, SkeletonCard } from "@/components/ui/skeleton";
import { EmptyState, FailureState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { residentQuery } from "@/lib/resident-queries";
import { readApiError } from "@/lib/api-contract";
import { downloadToDevice } from "@/lib/documents";
import {
  type ResidentClaim,
  type ResidentFinanceView,
  type ResidentInvoice,
  statementPdfUrl,
} from "@/lib/finance-api";
import { formatMoney } from "@/lib/format";
import {
  filterInvoices,
  groupInvoicesByYear,
  invoiceRowCopy,
  oneOffLabel,
  outstanding,
  type PaymentFilter,
  paymentStats,
  totalOutstanding,
} from "@/lib/invoice-ledger";
import { toastError } from "@/lib/toast";

/**
 * Every month the resident has been billed for, newest first.
 *
 * ## The screen was six blocks deep before it said anything
 *
 * It opened on a bordered `Total outstanding` card, then a second bordered
 * `Due next` card carrying its own amount, its own due label, the reference code
 * and both buttons, then a destination row for the Offer Program, then a strip
 * of three metric tiles, then claims, then the list. Two money figures in the
 * first two hundred points — one of which *contains* the other — and a
 * navigation row wedged between the money and the metrics that explained it.
 * Every individual piece was right and the arrangement made the reader assemble
 * the answer themselves.
 *
 * What it is now, in the order the questions get asked:
 *
 * | | |
 * | --- | --- |
 * | **The card** | what I owe in total, whether any of it is late, and what the buttons below are about to pay |
 * | **Two buttons** | pay that amount, or say I already have. The reference code is not here — it is on the pay screen the first one opens |
 * | **Credit** | money of mine the hostel is holding. Absent when there is none |
 * | **Offer Program** | certified receipts, perks and offers — a door, on the shelf shape More uses |
 * | **Pending claims** | what I have told them, still unverified. Absent when there is none |
 * | **Invoices** | the history, grouped by year, filtered by one exclusive control |
 *
 * The three `<StatTile>`s went. `Settled 4 of 7` was a metric about a list, so
 * it became that list's subheading, and a tile strip repeating the card above it
 * is the same reading twice at two sizes.
 *
 * ## The actions are on the page, not in the card
 *
 * The card used to end in a white `bg-card` shelf holding the code and both
 * buttons, which made one object read as two cards stacked with no gap. They sit
 * on the page background now: a control on the page is unambiguously a control,
 * and the card above it is unambiguously a statement. `resident-payments.tsx`
 * has the rest of that argument.
 *
 * ## The filter is a `<Segmented>`, not chips
 *
 * All / Open / Settled are mutually exclusive views of one list, which is
 * squarely what that component is for and squarely what chips are not — a chip
 * row implies you could tick two of them. `(admin)/money.tsx` draws its
 * Owing / Paid control the same way, so the two portals now filter a list of
 * invoices with the same object.
 *
 * ## The card and the button name the same number
 *
 * They did not. The card headlined `Total outstanding` — every open invoice
 * added up — and a `Next due` half that gave the next charge's *name* and due
 * date but no amount, over a button that said `Pay now` and opened the oldest
 * open invoice. A resident with an Rs 2,000 admission fee and Rs 16,800 of rent
 * saw `Rs 18,800`, tapped `Pay now`, and arrived at a Rs 2,000 payment screen.
 *
 * The line under the balance carries that invoice's own amount now, and the
 * button reads `Pay Rs 2,000`. The total is still the headline, because "what do
 * I owe" is the first question anybody opens this tab with — it is just no
 * longer the only figure on screen when the answer to the second question is a
 * different one.
 *
 * ## The list is grouped by year, in the reader's calendar
 *
 * `NOTES.md` §5: lists group by date and the heading sits **outside** the card,
 * on the page background. The rows here are months, so the group is the year —
 * and a resident in their second year had `Jan` twice in one flat column with
 * nothing to tell them apart.
 *
 * The year has to be *derived* rather than sliced off the period key. Grouping
 * on `"2026"` while every row underneath was formatted in Bikram Sambat put a
 * `2026` heading over a card of `2083 BS` rows, which is the screen reading in
 * two calendars at once and explaining neither. `invoiceYear` below does it in
 * whichever calendar `useDates()` is in, and `groupInvoicesByYear` takes it as a
 * parameter for exactly that reason.
 *
 * Inside a group the rows drop the year — `Bhadra`, `Due Aswin 15` — because the
 * heading two rows up is already carrying it, and printing it three times in one
 * row is what made a billing month over a due date look like a bug.
 *
 * `groupInvoicesByYear` also decides where a one-off invoice goes: an admission
 * fee carries `period: null`, so it is filed by its due date rather than dropped.
 *
 * ## Against `resident-payments-page.tsx` (§5.1)
 *
 * Ported from the web when this screen was rebuilt around *what do I owe right
 * now, and how do I pay it*: the focus invoice, the metric facts and the status
 * filter. Not ported: its four-column metric grid keeps "Total Outstanding" as a
 * tile **and** prints it on the focus card.
 */

const FILTERS: readonly { label: string; value: PaymentFilter }[] = [
  { label: "All", value: "all" },
  { label: "Open", value: "open" },
  { label: "Settled", value: "settled" },
];

/**
 * How many unverified claims the section shows before it folds.
 *
 * Two, because the section sits *above* the invoice list and a resident with
 * five outstanding proofs would otherwise push the thing they came for off the
 * screen. `View all` is a disclosure rather than a route: there is no
 * claims-only screen, and inventing one to hold three more rows would be a
 * destination nobody navigates to twice.
 */
const CLAIM_PREVIEW = 2;

export default function ResidentPaymentsScreen() {
  const dates = useDates();

  /*
   * `payments` is published by all four of the services that can change what a
   * resident owes without the resident doing anything: a claim approved or
   * rejected, a gateway payment reviewed, a bank statement reconciled, a
   * statement imported. This is the screen where being one refresh stale is
   * most expensive — it is the balance somebody is about to pay again.
   */
  const query = residentQuery.finance();
  const finance = useResource<ResidentFinanceView>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  const [statementBusy, setStatementBusy] = useState(false);
  const [filter, setFilter] = useState<PaymentFilter>("all");
  const [allClaims, setAllClaims] = useState(false);

  const shareStatement = useCallback(async () => {
    setStatementBusy(true);

    try {
      // The control says "Download statement", so it downloads. Progress goes
      // to the global toaster and the shade — see `downloadToDevice`.
      await downloadToDevice({
        extension: "pdf",
        fileName: "hostel-statement",
        label: "Statement",
        mimeType: "application/pdf",
        url: statementPdfUrl(),
      });
    } catch (caught) {
      toastError("Could not open your statement", readApiError(caught));
    } finally {
      setStatementBusy(false);
    }
  }, []);

  const invoices = useMemo(() => finance.data?.invoices ?? [], [finance.data]);

  /*
   * The group heading, in the reader's own calendar.
   *
   * `groupInvoicesByYear` used to slice `"2026"` off the period key, which on a
   * Bikram Sambat phone — the default — drew a `2026` heading over a card whose
   * every row said `2083 BS`. Relabelling the group would not have fixed it:
   * one Gregorian year holds two BS ones, so the grouping itself has to be done
   * in the calendar the headings are written in. See `invoice-ledger.ts`.
   *
   * A one-off invoice has no month, so it is filed by its due date — the same
   * fallback `oneOffLabel` covers on the row itself.
   */
  const invoiceYear = useCallback(
    (invoice: ResidentInvoice) =>
      invoice.month ? dates.periodYear(invoice.month) : dates.year(invoice.dueDate),
    [dates],
  );

  const groups = useMemo(
    () => groupInvoicesByYear(filterInvoices(invoices, filter), invoiceYear),
    [filter, invoiceYear, invoices],
  );
  const stats = useMemo(() => paymentStats(invoices), [invoices]);
  const focus = stats.nextDue;
  const focusOwed = focus ? outstanding(focus) : 0;

  /*
   * Two actions, both `<IconButton>`.
   *
   * The statement button used to be a bare `Pressable` around an `Ionicons`
   * with **no `color`** — which is black, so on a dark bar in dark mode it was a
   * control nobody could see. `IconButton` reads `colors.foreground` and is the
   * header-action shape the rest of the app already uses, bell included.
   *
   * It has no `disabled` prop, and does not need one here: the glyph still
   * swaps to an hourglass while the download runs, and the handler returns
   * early rather than queueing a second fetch of the same PDF.
   */
  const header = (
    <AppBar
      actions={
        <View className="flex-row items-center gap-2">
          <IconButton
            label={statementBusy ? "Downloading your statement" : "Download statement"}
            name={statementBusy ? "hourglass-outline" : "download-outline"}
            onPress={() => {
              if (statementBusy) {
                return;
              }

              void shareStatement();
            }}
          />
          <NotificationBell />
        </View>
      }
      // `large`, matching the admin tabs and the other three resident ones. See
      // the note in `(resident)/more.tsx`.
      large
      title="Payments"
    />
  );

  if (finance.loading) {
    return (
      /*
        The painted card, the two buttons, the doors, then the list — the bands
        this screen actually lands in. A skeleton is only worth more than a
        spinner if it is the shape of what replaces it; see Home's note.
      */
      <Screen header={header} insideTabs padded={false} scroll>
        <View className="px-5">
          <Skeleton height={186} radius={22} />
        </View>

        <View className="gap-4 px-5 pt-4">
          <View className="flex-row gap-3">
            <View className="flex-1">
              <Skeleton height={48} radius={12} />
            </View>
            <View className="flex-1">
              <Skeleton height={48} radius={12} />
            </View>
          </View>

          <Skeleton height={62} radius={16} />

          <View className="gap-3">
            <Skeleton height={18} width="40%" />
            <Skeleton height={38} radius={19} />
            <SkeletonCard rows={4} />
          </View>
        </View>
      </Screen>
    );
  }

  if (finance.error || !finance.data) {
    return (
      <Screen header={header} insideTabs>
        <FailureState
          message={finance.error ?? "Your invoices could not be loaded."}
          onRetry={finance.reload}
          title="Couldn't load payments"
        />
      </Screen>
    );
  }

  const { claims, credit } = finance.data;
  const openClaims = claims.filter((claim) => claim.status !== "APPROVED");
  // A rejected claim stays listed so its reason is readable, but it is no
  // longer waiting on anyone — the pill counts only the ones still undecided.
  const pendingClaims = openClaims.filter((claim) => claim.status === "PENDING").length;
  const shownClaims = allClaims ? openClaims : openClaims.slice(0, CLAIM_PREVIEW);

  return (
    <Screen
      header={header}
      insideTabs
      onRefresh={finance.refresh}
      padded={false}
      refreshing={finance.refreshing}
      scroll
    >
      <ResidentDuesCard
        claimsPending={pendingClaims}
        /*
          One line, and only when there is something to pay. The heading is an
          instruction rather than a label — `Pay this next` names the invoice the
          two buttons directly below act on, where `Next due` named a date and
          left the reader to work out that the figure above it was a different
          number. It carries that invoice's own amount for the same reason.

          A settled account passes none: a `Pay this next — nothing` line is a
          row of card spent saying nothing happened, and the `Settled` pill on
          the balance has already said it.
        */
        lines={
          focus
            ? [
                {
                  amount: focusOwed,
                  heading: "Pay this next",
                  /*
                    What the charge is, in full. A joining invoice reads
                    `Admission fee + Security deposit` because that is what the
                    one reference code below settles — both halves, one
                    transfer. Naming only the fee, which is what reading the
                    first line did, understates the figure beside it by the
                    size of the deposit.
                  */
                  label: oneOffLabel(focus) ?? `Monthly rent — ${dates.periodMonth(focus.month)}`,
                  note: focus.dueDate ? `Due ${dates.date(focus.dueDate)}` : "No due date",
                },
              ]
            : []
        }
        overdueCount={stats.overdueCount}
        total={totalOutstanding(invoices)}
      />

      <View className="gap-5 px-5 pt-4">
        {/*
          The pair exists only when there is something to act on. On a settled
          account they would be a form about an invoice nobody owes and a proof
          form for a payment nobody needs to make — two controls kept alive to
          preserve a layout, which is the opposite of what a control is for.

          Equal width because neither is the fallback. A resident who
          transferred from their bank has already done the hard part, and
          burying the claim behind a secondary treatment is what produces
          payments the hostel cannot see.
        */}
        {focus ? (
          /*
            The reference code stood under these buttons and has gone.

            It was the same code the `Pay` button leads to: `invoice/[id]/pay`
            opens on a `<ReferenceCard>` carrying it under `PUT THIS IN THE
            REMARKS`, beside the wallet the resident is about to quote it in. A
            copy strip here asked somebody looking at a balance to copy a string
            for a transfer they had not started yet, one tap before the screen
            that hands them the same string with the instruction attached — and
            a code copied a screen early is a code copied against whichever
            figure was on screen at the time, which here is the total rather
            than the invoice it settles.

            The code lives where the payment happens. This screen is the
            balance and the history.
          */
          <View className="flex-row gap-3">
            <View className="flex-1">
              {/*
                The button names the figure it is about to charge.

                `Pay now` under a card headlining `Rs 18,800` reads as a button
                that pays Rs 18,800, and it never was — it opens the oldest open
                invoice, which on a new resident's first screen is a Rs 2,000
                admission fee. Putting the amount on the control closes the gap
                at the last point where closing it still prevents the surprise.
              */}
              <Button
                label={`Pay ${formatMoney(focusOwed)}`}
                onPress={() => router.push(`/invoice/${focus.id}/pay`)}
              />
            </View>
            <View className="flex-1">
              <Button
                label="I've paid"
                onPress={() => router.push(`/invoice/${focus.id}/claim`)}
                variant="outline"
              />
            </View>
          </View>
        ) : null}

        {credit > 0 ? (
          /*
            Carried from an overpayment, and applied to the next invoice by the
            server. Shown only when it exists — a permanent "Rs 0 credit" row
            teaches people to ignore the line. It is a *fact about the account*
            rather than a figure on the statement, which is why it sits below the
            card instead of taking a third slot on it.

            `View details` goes to the invoice the credit will be spent on,
            where it appears as a signed line in the breakdown. Without an open
            invoice there is nothing to show, so the link is not drawn — a
            chevron that goes nowhere is worse than no chevron.
          */
          <Card className="flex-row items-center gap-3">
            <View className="flex-1">
              <Text variant="caption">Credit balance</Text>
              <Text variant="label">{formatMoney(credit)}</Text>
            </View>

            {focus ? (
              <SectionLink
                label="View details"
                onPress={() => router.push(`/invoice/${focus.id}`)}
              />
            ) : (
              <Text variant="caption">Applied to your next invoice</Text>
            )}
          </Card>
        ) : null}

        {/*
          The programme's own view, as a door rather than a third icon in the app
          bar. Three glyphs up there would crowd a title, and this is not a
          header action in any case — the question it answers ("where are my
          certified receipts") is not one somebody asks while looking at a
          balance. It keeps its place directly under the money because that is
          where the reference code they are about to quote already is, and it is
          a `<CardRow>` because that is the shape every other resident door now
          takes — see `(resident)/more.tsx`.
        */}
        <CardRow
          icon="receipt-outline"
          onPress={() => router.push("/khata")}
          subtitle="Egg, meals, laundry — on next month's bill"
          title="Khata"
          tone="brand"
        />

        <CardRow
          icon="ribbon-outline"
          onPress={() => router.push("/offer-program/mine")}
          subtitle="Certified receipts, perks & your offers"
          title="Offer Program"
        />

        {openClaims.length > 0 ? (
          <View>
            <SectionHeader
              action={
                openClaims.length > CLAIM_PREVIEW ? (
                  <SectionLink
                    label={allClaims ? "Show less" : "View all"}
                    onPress={() => setAllClaims((value) => !value)}
                  />
                ) : undefined
              }
              subtitle={
                pendingClaims === openClaims.length
                  ? "Waiting on the hostel to verify"
                  : pendingClaims > 0
                    ? `${pendingClaims} waiting on the hostel`
                    : "Not accepted by the hostel"
              }
              title={pendingClaims === openClaims.length ? "Pending claims" : "Your claims"}
            />

            <Card padding="px-4 py-1">
              {shownClaims.map((claim, index) => (
                <View key={claim.eventId}>
                  {index > 0 ? <RowDivider /> : null}
                  <ClaimRow claim={claim} />
                </View>
              ))}
            </Card>
          </View>
        ) : null}

        <View>
          <SectionHeader
            /*
              The `Settled` tile's fact, moved onto the heading of the list it
              was counting. It is one sentence about this section rather than a
              third of a metric strip repeating the card above it.
            */
            subtitle={
              invoices.length > 0
                ? `${stats.settledCount} of ${invoices.length} settled`
                : undefined
            }
            title="Invoices"
          />

          {invoices.length === 0 ? (
            <Card>
              <EmptyState
                compact
                description="Your hostel has not billed you yet. Invoices appear here as soon as they do."
                icon="receipt-outline"
                title="No invoices"
              />
            </Card>
          ) : (
            <View className="gap-4">
              <Segmented onChange={setFilter} options={FILTERS} value={filter} />

              {groups.length === 0 ? (
                <Card>
                  <EmptyState
                    compact
                    description={
                      filter === "open"
                        ? "Every month billed to you is settled."
                        : "Nothing you have been billed for has settled yet."
                    }
                    icon={filter === "open" ? "checkmark-circle-outline" : "time-outline"}
                    title={filter === "open" ? "Nothing open" : "No settled months"}
                    tone={filter === "open" ? "success" : "muted"}
                  />
                </Card>
              ) : (
                groups.map((group) => (
                  <View className="gap-2" key={group.year ?? "undated"}>
                    {/*
                      On the page background, outside the card — `NOTES.md` §5.
                      Drawn even when there is only one year: the heading is what
                      tells the reader the column of `Jan`, `Feb`, `Mar` below it
                      is a year rather than a running list, and a group label
                      that appears only once a second group exists is a label
                      nobody learns to look for.
                    */}
                    <Text className="px-1" variant="label">
                      {group.year ?? "No date recorded"}
                    </Text>

                    <Card padding="px-4 py-1">
                      {group.invoices.map((invoice, index) => {
                        const owed = outstanding(invoice);
                        const copy = invoiceRowCopy(
                          invoice,
                          dates.periodMonth,
                          dates.dayMonth,
                        );

                        return (
                          <View key={invoice.id}>
                            {index > 0 ? <RowDivider /> : null}
                            <ListRow
                              onPress={() => router.push(`/invoice/${invoice.id}`)}
                              right={
                                /*
                                  The amount over its state, both on the right
                                  margin. `<StatusText>` rather than
                                  `<StatusPill>`: a column of filled chips under
                                  a column of figures gives the right edge a
                                  ragged run of coloured rectangles that read as
                                  louder than the money they annotate. The
                                  component's own note has the argument.
                                */
                                <View className="items-end gap-1">
                                  <Money
                                    owed={owed > 0}
                                    value={owed > 0 ? owed : invoice.dueAmount}
                                  />
                                  <StatusText status={invoice.status} />
                                </View>
                              }
                              /*
                                What the charge is, over which month it is for.

                                The row used to be the other way about — the
                                month as the title, the due date under it — and
                                it read as a glitch: `Bhadra` over `Due Aswin
                                15`, two month names on one row with nothing
                                saying which was which, and neither of them
                                saying what the row *was*. A resident scanning
                                their payments wants "rent" before they want
                                "Bhadra".

                                A part month replaces the due line with the
                                month and the days it covers, because the
                                smaller figure on the right is otherwise
                                unexplained — and because a basis snapshotted
                                under the older format reads `28/30 days`, which
                                under a heading that is a year names no month at
                                all. `invoiceRowCopy` holds both rules and is
                                tested on them.

                                Not the reference code, which is on the strip at
                                the top of this screen and on the invoice's own —
                                repeating it on every row of a list where most
                                rows are settled months puts a call to action on
                                history.
                              */
                              subtitle={copy.subtitle}
                              title={copy.title}
                            />
                          </View>
                        );
                      })}
                    </Card>
                  </View>
                ))
              )}
            </View>
          )}
        </View>
      </View>
    </Screen>
  );
}

/**
 * One unverified claim: what was paid, how, when, and — if it was turned down —
 * why.
 *
 * ## The rejection reason was on the wire the whole time
 *
 * This row printed an amount, a status and a date, and the date was always
 * blank because the type named the field `createdAt` and the server sends
 * `occurredAt`. Worse, a `REJECTED` claim said only "Rejected": the server has
 * carried `rejectionReason` since the review queue was built, and its own
 * comment says the field exists so that "the one person who has to act on the
 * decision" is told what to fix. The client never read it, so a resident whose
 * screenshot was unreadable saw a red word and no way to know what to do next.
 *
 * It is drawn in the destructive tone under the row rather than as a third
 * caption line, because it is the only thing on this card that asks for an
 * action.
 *
 * ## The method leads the subtitle
 *
 * A resident with three pending claims tells them apart by what they did —
 * "the eSewa one", "the bank one" — not by amounts that are the same every
 * month. `<WalletMark>` puts the brand's own mark in the row's leading slot for
 * the three wallets that have one, and a tinted glyph for cash and bank.
 */
function ClaimRow({ claim }: { claim: ResidentClaim }) {
  const dates = useDates();

  const rejected = claim.status === "REJECTED";

  return (
    <View>
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

      {rejected && claim.rejectionReason ? (
        <View className="pb-3 pl-12">
          <Text className="text-destructive" variant="caption">
            {claim.rejectionReason}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/*
 * `FocusCard` and `SettledCard` stood here.
 *
 * The first was a bordered white card holding the oldest open month's amount,
 * its due label, its reference code and both buttons — everything that is now
 * the painted card and the button row under it, drawn a second time under a
 * `Total outstanding` box that had already shown a bigger version of the same
 * figure. The second was its empty state: a tick, "Nothing outstanding", and a
 * sentence saying every month is settled.
 *
 * Both are `<ResidentDuesCard>` now, which says the same things in one object —
 * the balance on the paint, the month and the code below the rule, and a
 * `Settled` pill where the overdue count would be. The rule that survives them
 * and must not be lost: **the focus invoice is the oldest open month, not the
 * newest** (`paymentStats`). Somebody two months behind has to be pointed at
 * July, or it ages into a default while they settle August.
 */
