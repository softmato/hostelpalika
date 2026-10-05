import { OverallTabScreen } from "@/components/overall-views";
import { useIsOverall } from "@/components/hostel-switcher";
import { router } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { Ionicons } from "@expo/vector-icons";
import { Banknote } from "lucide-react-native";
import { Linking, Pressable, View } from "react-native";

import {
  DeniedNotice,
  useAdminAlerts,
  useAlertActions,
} from "@/components/admin-alerts";
import { ClaimCard } from "@/components/claim-card";
import { PaymentMonthStrip } from "@/components/payment-months";
import { NotificationBell } from "@/components/notification-bell";
import { AppBar } from "@/components/ui/app-bar";
import { StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { BillExtras } from "@/components/bill-extras";
import { Chip } from "@/components/ui/layout";
import { Lottie } from "@/components/ui/lottie";
import { Meter } from "@/components/ui/meter";
import { PersonAvatar } from "@/components/ui/avatar";
import { CardRow, ListRow } from "@/components/ui/list-row";
import { Money as Amount } from "@/components/ui/money";
import { Screen } from "@/components/ui/screen";
import { Segmented } from "@/components/ui/segmented";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonCard, SkeletonRows } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { readableRole } from "@/constants/roles";
import { useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { type AdminInvoiceRow, bulkApproveClaims } from "@/lib/admin-api";
import { buildAlertFeed } from "@/lib/admin-alerts";
import {
  type AdminMoneyData,
  adminQuery,
  prefetchAdminResident,
} from "@/lib/admin-queries";
import { recordCashPayment, voidInvoice } from "@/lib/admin-manage-api";
import {
  amountOwed,
  type InvoiceSegment,
  invoiceSegment,
  isFirstMonth,
  isProRated,
  notBilledReason,
  projectedAmount,
  searchInvoiceRows,
} from "@/lib/admin-money";
import { readApiError } from "@/lib/api-contract";
import { claimsForPeriod, paymentMonths } from "@/lib/payment-months";
import { openConfirm } from "@/lib/confirm";
import { waiveLateFine } from "@/lib/khata-api";
import { formatMoney, humanizeEnum, nepalPeriodKey } from "@/lib/format";
import { toastError, toastSuccess } from "@/lib/toast";

const SUCCESS_ANIMATION = require("../../../assets/lottie/success.lottie");

/**
 * Money — a statement, and shaped like one.
 *
 * ## What this screen is, as distinct from the others
 *
 * Every admin tab briefly opened with the same painted band under the same
 * painted bar, and five screens whose top two hundred points are identical is
 * not a design system — it is a failure to say where you are. Each tab now has
 * its own *shape*, sharing only the tokens:
 *
 * - **Home** is a full-bleed hero with the building behind it. It is the front
 *   door, so it says which app and which hostel.
 * - **Money is a card on a page.** A statement is an object you hold, so the
 *   colour is inset on all four sides with a shadow under it, and the bar above
 *   it is ordinary page chrome.
 * - **Residents** leads with search, because a directory is something you look
 *   *into*.
 * - **Alerts** leads with its filter tabs, because an inbox is something you
 *   triage.
 * - **Today** leads with the date and the roll call's progress.
 * - **More** leads with who you are signed in as, and is deliberately calm.
 *
 * ## Two segments, not four — the tabs stopped double-counting people
 *
 * `04_hostel_admin/02_payments_management.png` puts Paid / Unpaid / Partial /
 * Overdue across the top of its table, and the phone took that as Owing /
 * Overdue / Unbilled / Paid — where the first of the four **contains** the
 * second and third. Over a roster of forty that control read `Owing 23 ·
 * Overdue 8 · Unbilled 3 · Paid 17`: four counts that cannot be added up, in
 * the one place a reader is entitled to assume the tabs divide the list between
 * them. On the mockup's own wide table those are genuinely four disjoint states
 * of one invoice; the phone had turned them into a hierarchy and drawn it flat.
 *
 * So the control is `Owing / Paid`, which does partition the roster, and the
 * two subsets it lost are said in ways that do not hide anybody:
 *
 * - **Overdue sorts to the top** of the owing list (`outstandingRows`), so the
 *   people to ring today are the first rows under the thumb rather than one tap
 *   away behind a filter that hides the other twenty.
 * - **Every owing row carries its own status pill**, which is where "unpaid vs
 *   partial vs overdue vs never billed" belongs — on the person it describes.
 * - **The header states both counts** as a sentence, so the two figures the old
 *   segments carried are still on screen without pretending to be views.
 *
 * Defaulting to **Owing** rather than to everything: a screen that opens on the
 * people who have already paid has forgotten what it is for. `Paid` exists so
 * somebody can answer "did so-and-so pay" without a laptop, which is the only
 * reason a settled row is worth rendering at all.
 *
 * ## Search, because "did so-and-so pay" is the second question
 *
 * A forty-row list sorted by urgency is the right answer to "who do I chase"
 * and the wrong one to "what about room 204" — the row is somewhere in the
 * middle, ranked by an amount the reader does not know. The field filters what
 * is already in hand (`searchInvoiceRows`), matching name, phone and room.
 *
 * It appears only once the list is long enough to need it. A hostel with six
 * residents can see all six, and a search box over six rows is a control that
 * exists to be ignored.
 *
 * ## Order: what needs a decision, then what is owed
 *
 * The verify queue is above the list, because a payment claim is a resident's
 * money in limbo while their invoice still reads unpaid to them — the only
 * thing here with a clock on it. It is **absent** when there is nothing to
 * verify rather than drawn as an empty card: that section is empty on most days
 * for most hostels, and a permanent "Nothing to verify" box is a heading, a
 * sentence and a card's worth of screen sitting between the figures and the
 * list, every single time, to report a non-event. The money card's own
 * `N to check` pill already says when the queue is live.
 *
 * ## Why the list is not the web's matrix
 *
 * The portal's table is one row per resident with seven columns and a month
 * picker. What survives the trip to a phone is "who has not paid", sorted by
 * what is owed, with the phone number one tap away. Issuing, editing, voiding,
 * the fee schedule and the billing run are keyboard jobs and stay in the
 * browser, one section down.
 */
/*
 * `MoneyData` and its loader moved to `lib/admin-queries.ts` as
 * `adminQuery.money(period)` — one definition the portal's warm-up can run under
 * the same key this screen reads. The period is in that key, so a month already
 * looked at comes back instantly and a month that has not been is a fresh load.
 */

function BranchAdminMoneyScreen() {
  /*
   * The month on screen, and the only piece of state on this screen that is a
   * *question* rather than a view of the answer. It is the first thing in the
   * loader's dependency list because `useResource` refetches when the loader's
   * identity changes — a filter that does not appear there is a filter that
   * silently does nothing, which is the failure that hook's own notes record.
   */
  const [period, setPeriod] = useState(nepalPeriodKey());
  const dates = useDates();
  const { colors } = useAppTheme();

  const moneyQuery = adminQuery.money(period);
  const money = useResource<AdminMoneyData>(moneyQuery.load, {
    cacheKey: moneyQuery.key,
    topics: moneyQuery.topics,
  });
  const alerts = useAdminAlerts();
  const actions = useAlertActions();

  const [segment, setSegment] = useState<InvoiceSegment>("owing");
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);

  /*
   * `buildAlertFeed` with one source populated: it is the module that owns the
   * row shape and the oldest-first ordering, and duplicating that mapping here
   * would be a second place for the claim subtitle to drift from the one on the
   * combined queue.
   */
  /*
   * Scoped to the month on screen, so the queue under the strip is the queue for
   * the chip that is lit. `claimsForPeriod` also decides where a claim with no
   * period at all goes — an admission fee is billed as a one-off and carries
   * `period: null`, and a strict match would hide the first claim a new resident
   * ever files from every month in the strip.
   */
  const monthClaims = useMemo(
    () => claimsForPeriod(alerts.data?.claims ?? [], period),
    [alerts.data, period],
  );

  const claimRows = useMemo(
    () =>
      buildAlertFeed({
        claims: monthClaims,
        complaints: [],
        inquiries: [],
        sos: [],
      }),
    [monthClaims],
  );
  /** Whole queues this account may not read — never folded into "nothing here". */
  const denied = useMemo(() => alerts.data?.denied ?? [], [alerts.data]);

  const claimById = useMemo(
    () => new Map(monthClaims.map((claim) => [claim.eventId, claim])),
    [monthClaims],
  );

  /*
   * `Approve all` — only the claims that passed every server check, confirmed
   * with the count and the total first. The server re-checks each id and skips
   * any that went amber since this rendered.
   */
  const greenClaims = useMemo(() => monthClaims.filter((claim) => claim.allGreen), [monthClaims]);

  const approveAllGreen = useCallback(() => {
    const total = greenClaims.reduce((sum, claim) => sum + claim.amount, 0);

    openConfirm({
      confirmLabel: "Approve all",
      message: `${greenClaims.length} payments, ${formatMoney(total)} in all. Each resident gets a receipt.`,
      onConfirm: async () => {
        try {
          const result = await bulkApproveClaims(greenClaims.map((claim) => claim.eventId));

          toastSuccess(
            `${result.approved.length} approved`,
            result.skipped.length > 0 ? `${result.skipped.length} left for you to check.` : undefined,
          );
          money.refresh();
          alerts.refresh();
        } catch (error) {
          toastError("Could not approve", readApiError(error));
        }
      },
      title: "Approve every payment that passed?",
    });
  }, [alerts, greenClaims, money]);

  const rows = useMemo(() => money.data?.invoices.rows ?? [], [money.data]);

  /*
   * The strip's chips. Built from the period roll-up rather than from the month
   * on screen, because the count on each chip is the whole point of it: an owner
   * sweeping back through the year is looking for the months that still have
   * somebody in them, and a strip that could only count the month it is already
   * showing would answer that with one number.
   *
   * Empty without `viewPayments` — that roll-up is the read a warden can be
   * refused — and the strip renders nothing rather than one lonely chip. The
   * screen still works: it is showing the current month, which is what it opened
   * on anyway.
   */
  const monthChips = useMemo(
    () =>
      paymentMonths(money.data?.periods?.months ?? [], {
        current: nepalPeriodKey(),
      }),
    [money.data],
  );

  /**
   * A room for a claim, joined from the month's invoice matrix.
   *
   * The claims queue knows who paid and not where they live; the matrix knows
   * both. Joining here rather than asking the server for it keeps the review
   * route as it is — and a claim whose resident is not in this month's matrix
   * simply has no room line, which is the honest outcome for somebody who moved
   * out or was never billed.
   */
  const roomByResident = useMemo(
    () =>
      new Map(
        rows.map((row) => [
          row.resident.id,
          [humanizeEnum(row.resident.roomType), row.resident.roomNumber]
            .filter((part) => Boolean(part) && part !== "—")
            .join(" · "),
        ]),
      ),
    [rows],
  );

  /*
   * Two counts that add up to the roster. See the note at the top: the four
   * that did not were the single most confusing thing on this screen.
   */
  const segments = useMemo(
    () => [
      {
        count: invoiceSegment(rows, "owing").length,
        label: "Owing",
        value: "owing" as const,
      },
      {
        count: invoiceSegment(rows, "settled").length,
        label: "Paid",
        value: "settled" as const,
      },
    ],
    [rows],
  );

  const inSegment = useMemo(
    () => invoiceSegment(rows, segment),
    [rows, segment],
  );
  const listed = useMemo(
    () => searchInvoiceRows(inSegment, query),
    [inSegment, query],
  );

  const totals = money.data?.invoices.totals;

  /*
   * There were five tiles across the top here — `To review`, `Paid`, `Unpaid`,
   * `Overdue`, `Collected` — in a row that scrolled sideways because three is
   * what fits on a 360dp phone.
   *
   * They are gone, and nothing they said was lost with them. Every one of the
   * five is stated somewhere it is also actionable: `To review` is the heading
   * on the claim queue directly below ("3 claims to verify"), `Overdue` and the
   * never-billed count are in `listSubtitle` over the list those people are
   * already at the top of, `Paid` versus `Unpaid` is the segmented control that
   * switches between them, and `Collected` is the figure over the trend chart.
   * A tile that restates a heading two hundred points further down is furniture
   * — and five of them pushed the queue, which is the screen's actual job, below
   * the fold.
   */

  /*
   * The header's sentence — and the home of the two figures the `Overdue` and
   * `Unbilled` segments used to carry. Stated rather than filtered: an admin who
   * reads "8 overdue" is looking at those eight already, since they are the
   * first rows in the list.
   *
   * The counts come from the server's own `totals` rather than from re-filtering
   * `rows` here, so this line cannot drift from the figures on the card above it.
   * They describe the month, not the visible list, which is why the search
   * branch replaces the whole sentence instead of appending to it.
   */
  const listSubtitle = useMemo(() => {
    if (query.trim()) {
      return listed.length === 1 ? "1 match" : `${listed.length} matches`;
    }

    if (segment === "settled") {
      return listed.length === 1
        ? "1 person has settled"
        : `${listed.length} people have settled`;
    }

    return [
      listed.length === 1
        ? "1 person still owes"
        : `${listed.length} people still owe`,
      totals?.overdue ? `${totals.overdue} overdue` : null,
      totals?.notBilled ? `${totals.notBilled} never billed` : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }, [listed.length, query, segment, totals]);

  /*
   * Empty because the search found nobody is a different fact from empty because
   * there is nobody — the first needs the query back and a way out of it, the
   * second is good news on the owing list and bad news on the paid one.
   */
  const emptyDescription = useMemo(() => {
    if (query.trim()) {
      return `Nobody in this list matches ${query.trim()}. Clear the search, or try the other tab.`;
    }

    return segment === "settled"
      ? "Nobody in this month has settled yet."
      : "Everybody has paid what they were billed.";
  }, [query, segment]);

  /*
   * The row sheet. Two writes live here — recording cash and voiding — because
   * both are things somebody does *with the resident in front of them*, which
   * is the case the browser hand-off served worst: money changed hands at the
   * desk and the record waited until whenever a laptop was next opened.
   */
  const account = useAppSelector((state) => state.auth.account);
  const me = account?.name?.trim() || account?.email || "";
  const [open, setOpen] = useState<AdminInvoiceRow | null>(null);
  /*
   * `slip` is the idempotency key the server wants as a paper receipt number.
   * Minted once per opening, so a double tap or a retry after a dropped
   * connection lands on the same payment instead of banking it twice.
   */
  const [cash, setCash] = useState({ amount: "", collectedBy: "", note: "", slip: "" });
  const [editCollector, setEditCollector] = useState(false);
  const [showNote, setShowNote] = useState(false);
  /* Said beside the button it is about, not in a toast at the top of the screen. */
  const [cashError, setCashError] = useState<string | null>(null);
  const [done, setDone] = useState<{ amount: number; pending: boolean } | null>(null);
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState("");
  const [voidError, setVoidError] = useState<string | null>(null);
  /*
   * Which of the sheet's two actions is at the server. They are stacked in the
   * same sheet — take the cash, or void the invoice — and one boolean spun both
   * buttons at once, so the sheet reported that it was voiding an invoice while
   * it was banking a payment.
   */
  const [busy, setBusy] = useState<"cash" | "void" | null>(null);

  const openRow = useCallback((row: AdminInvoiceRow) => {
    setOpen(row);
    /*
     * The sheet's "Open their record" is one tap from here and lands on the
     * slowest screen in the portal. Opening the sheet is a far better signal
     * than a touch-down on the row would be — by the time this runs the reader
     * has already chosen this person.
     */
    prefetchAdminResident(row.resident.id);
    setCash({
      amount:
        row.payment && row.payment.dueAmount > row.payment.paidAmount
          ? String(row.payment.dueAmount - row.payment.paidAmount)
          : "",
      collectedBy: me,
      note: "",
      slip: `APP-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toUpperCase(),
    });
    setEditCollector(!me);
    setShowNote(false);
    setCashError(null);
    setDone(null);
    setVoidOpen(false);
    setVoidReason("");
    setVoidError(null);
  }, [me]);

  const takeCash = useCallback(async () => {
    if (!open?.payment) {
      return;
    }

    const amount = Number(cash.amount);

    if (!Number.isInteger(amount) || amount <= 0) {
      setCashError("Enter the amount in whole rupees.");
      return;
    }

    if (cash.collectedBy.trim().length < 2) {
      setCashError("Add who took the cash.");
      setEditCollector(true);
      return;
    }

    setCashError(null);
    setBusy("cash");

    try {
      const { pendingApproval } = await recordCashPayment(open.payment.id, {
        amount,
        cashReceiptNumber: cash.slip,
        collectedBy: cash.collectedBy.trim(),
        note: cash.note.trim() || undefined,
      });
      setDone({ amount, pending: pendingApproval });
      money.refresh();
    } catch (error) {
      setCashError(readApiError(error));
    } finally {
      setBusy(null);
    }
  }, [cash, money, open]);

  /* Takes the late fine off this bill; the sheet then offers the smaller total. */
  const waiveFine = useCallback(() => {
    const payment = open?.payment;

    if (!payment) {
      return;
    }

    openConfirm({
      confirmLabel: "Waive fine",
      message: "The fine comes off this bill and stops growing.",
      onConfirm: async () => {
        try {
          await waiveLateFine(payment.id);
          const fine = payment.lines?.find((line) => line.basis === "FINE")?.amount ?? 0;
          const lines = payment.lines?.filter((line) => line.basis !== "FINE");
          const dueAmount = payment.dueAmount - fine;

          setOpen((current) =>
            current?.payment ? { ...current, payment: { ...current.payment, dueAmount, lines } } : current,
          );
          setCash((prev) => ({ ...prev, amount: String(Math.max(dueAmount - payment.paidAmount, 0)) }));
          toastSuccess("Fine waived");
          money.refresh();
        } catch (error) {
          toastError("Could not waive it", readApiError(error));
        }
      },
      title: "Waive the late fine?",
    });
  }, [money, open]);

  const voidIt = useCallback(async () => {
    if (!open?.payment) {
      return;
    }

    if (voidReason.trim().length < 3) {
      setVoidError("Write a short reason — the resident sees it.");
      return;
    }

    setVoidError(null);
    setBusy("void");

    try {
      await voidInvoice(open.payment.id, voidReason.trim());
      toastSuccess("Invoice voided", "The resident has been told why.");
      setOpen(null);
      money.refresh();
    } catch (error) {
      setVoidError(readApiError(error));
    } finally {
      setBusy(null);
    }
  }, [money, open, voidReason]);

  /*
   * "Payments", in step with the tab and with the portal — see `_layout.tsx`.
   *
   * `large`, so the name is set at the same 24 points Residents and Home set
   * theirs at. Those two carry their own header components and had always been
   * a size up; this bar was the only tab title still at bar-chrome size.
   */
  const header = (
    <AppBar actions={<NotificationBell />} large title="Payments" />
  );

  if (money.loading) {
    return (
      /*
        Skeletons, not a spinner. The shape of this screen is known before the
        data is — a money card, then a list of people — so drawing that shape
        means nothing moves when the figures land. A centred spinner followed by
        a full page appearing is what makes an app feel slower than it is.
      */
      <Screen header={header} insideTabs scroll>
        <View className="gap-6 pt-2">
          <SkeletonCard rows={2} />
          <SkeletonRows rows={6} />
        </View>
      </Screen>
    );
  }

  if (money.error || !money.data) {
    return (
      <Screen header={header} insideTabs>
        <ErrorState
          message={money.error ?? "The figures for that month could not be loaded."}
          onRetry={money.reload}
        />
      </Screen>
    );
  }

  const visible = showAll ? listed : listed.slice(0, 8);

  return (
    <>
      <Screen
        header={header}
        insideTabs
        onRefresh={() => {
          money.refresh();
          alerts.refresh();
        }}
        padded={false}
        refreshing={money.refreshing || alerts.refreshing}
        scroll
      >
        <View className="gap-5 pt-2">
          {/*
            The month, then the figures for it, then the queue it produced.

            This was a single painted collection card for the current month and
            nothing else — which made every question that starts "what about
            July" a trip to the browser. The strip is the picker the portal has
            as a dropdown, drawn as chips so the counts are on their faces; see
            `components/payment-months.tsx`.
          */}
          <PaymentMonthStrip
            months={monthChips}
            onSelect={setPeriod}
            value={period}
          />

          {/*
            Search, and the way out of searching at all.

            `Reconcile` is not a second search control: it is the answer to "I am
            not going to check forty of these by eye". It uploads the bank or
            wallet statement and matches it against the open invoices, which
            settles the ones that agree without anybody approving them
            individually — the same work this queue does one card at a time.

            It sits here rather than in the queue's own header because it is
            worth offering *before* the queue is read, and because on the day the
            queue is empty it is still the fastest way to settle a month.

            The field used to appear only over a list of more than eight, on the
            argument that a search box over six rows is a control that exists to
            be ignored. That gate is gone: the row now carries a control that is
            always worth showing, and a lone button floating on the right of an
            empty row reads as a layout accident rather than as a decision.
          */}
          <View className="flex-row items-center gap-2 px-5">
            <View className="flex-1">
              <Input
                autoCapitalize="none"
                autoCorrect={false}
                onChangeText={(next) => {
                  setQuery(next);
                  // The cap belongs to the list that was open, and a query
                  // narrows to a new one.
                  setShowAll(false);
                }}
                placeholder="Search name, room or phone"
                returnKeyType="search"
                value={query}
              />
            </View>

            <Button
              label="Reconcile"
              onPress={() => router.push("/manage/statements")}
              size="sm"
              variant="outline"
            />
          </View>

          {/*
            Present only when there is something to decide — see the note at the
            top. `DeniedNotice` is outside that condition on purpose: "nothing to
            verify" and "you are not allowed to see what needs verifying" are
            different facts, and an account without the grant has an empty claim
            list for a reason it needs told.
          */}
          {denied.length > 0 ? (
            <View className="px-5">
              <DeniedNotice denied={denied} />
            </View>
          ) : null}

          {claimRows.length > 0 ? (
            <View className="px-5">
              <SectionHeader
                action={
                  greenClaims.length > 1 ? (
                    <Button
                      label={`Approve ${greenClaims.length}`}
                      onPress={approveAllGreen}
                      size="sm"
                      variant="outline"
                    />
                  ) : undefined
                }
                subtitle="Their money is in limbo until one of these is decided"
                title={
                  claimRows.length === 1
                    ? "1 claim to verify"
                    : `${claimRows.length} claims to verify`
                }
              />

              {/*
                `ClaimCard`, not the shared `AlertCard`: on this tab every card
                is a claim, so the shape can be the decision itself — the
                screenshot on the card, the checks that did not pass spelled out,
                approve and reject under them. See `components/claim-card.tsx`.
              */}
              <View className="gap-3">
                {claimRows.flatMap((row) => {
                  const claim = claimById.get(row.id);

                  // The feed and the map are built from the same list one line
                  // apart, so this cannot miss — but a card without its claim
                  // would be a set of buttons over an empty body, and dropping
                  // it is better than drawing that.
                  return claim
                    ? [
                        <ClaimCard
                          actions={actions}
                          claim={claim}
                          key={row.id}
                          room={roomByResident.get(claim.residentId)}
                          row={row}
                        />,
                      ]
                    : [];
                })}
              </View>
            </View>
          ) : null}

          <View className="gap-3">
            <View className="px-5">
              <SectionHeader
                subtitle={listSubtitle}
                title="Residents"
              />

              <View className="gap-3">
                <Segmented
                  onChange={(next) => {
                    setSegment(next);
                    /*
                     * "Show all" belongs to the list that was open, not to the
                     * screen: carrying it across means switching from a 40-row
                     * segment to a 3-row one and back leaves the first silently
                     * expanded, with no control on screen saying so.
                     */
                    setShowAll(false);
                  }}
                  options={segments}
                  value={segment}
                />
              </View>
            </View>

            <View className="px-5">
              {listed.length === 0 ? (
                <EmptyCard
                  description={emptyDescription}
                  title={query.trim() ? "No match" : "Nothing here"}
                />
              ) : (
                /*
                  Separate cards, each with the resident's own initial circle.

                  This was one bordered card of hairline-separated rows, which is
                  the shape for facts that belong together — and a roster of
                  people who each owe their own money is the opposite of that.
                  Every banking app in `ui_inspiration_folder/app_recordings/`
                  draws a transaction list this way, and the reason is legibility
                  under a thumb: the gap between cards is a bigger, more reliable
                  visual break than a hairline, so the eye lands on one person at
                  a time instead of reading a table.
                */
                <View className="gap-3">
                  {visible.map((row) => (
                    <CardRow
                      key={row.resident.id}
                      /*
                       * The face — their own card photo, and the initial circle
                       * for anyone who has not uploaded one, coloured from the
                       * name so two adjacent rows of a forty-person roster tell
                       * themselves apart before either is read. Residents
                       * already does this; Money was drawing the same people as
                       * forty identical outlines.
                       */
                      left={
                        <PersonAvatar
                          image={row.resident.image}
                          name={row.resident.fullName}
                          size="md"
                        />
                      }
                      /*
                       * Opens the row rather than dialling. Calling used to be
                       * its only action because "editing an invoice, waiving a
                       * fee or recording a cash payment are portal jobs" — they
                       * are not, and taking cash at the desk is the most
                       * phone-shaped act in the whole finance surface. The call
                       * button is inside, next to the two writes and a way into
                       * the resident's record.
                       */
                      onPress={() => openRow(row)}
                      right={
                        /*
                         * `shrink-0` on the amount column. A seven-figure amount
                         * otherwise takes width from the status pill beside it
                         * and pushes it past the screen edge — the failure the
                         * payments-UI literature keeps naming, and the reason
                         * the name to its left is the thing allowed to truncate
                         * instead.
                         */
                        <View className="shrink-0 items-end gap-1">
                          {amountOwed(row) > 0 ? (
                            <Amount value={amountOwed(row)} />
                          ) : null}

                          {/*
                            Only on the mixed list, and now carrying the work the
                            retired segments used to do.

                            `Paid` is a single `displayStatus` by construction,
                            so a pill there repeats the segment the reader is
                            standing in, once per row, for the whole list.
                            `Owing` is the one that mixes — unpaid, partial,
                            pending proof, overdue, never billed — which is
                            exactly why "overdue" and "unbilled" belong here, on
                            the person they describe, rather than as two tabs
                            that hid everybody else to say the same thing.
                          */}
                          {segment === "owing" ? (
                            <StatusPill status={row.displayStatus} />
                          ) : null}
                        </View>
                      }
                      subtitle={[
                        humanizeEnum(row.resident.roomType),
                        row.resident.roomNumber,
                        /*
                         * Why this row's amount is smaller than its neighbours'.
                         * The billing run prorates from the move-in day, so a
                         * resident admitted mid-month is billed part of one —
                         * and an unexplained low figure on a list of rents reads
                         * as a billing fault rather than as arithmetic. Plain
                         * text in the subtitle, not a badge: nothing is wrong,
                         * and a coloured marker here would compete with the
                         * overdue pill, which is the thing on this screen that
                         * does want the eye.
                         */
                        isFirstMonth(row, period) ? "First month" : null,
                        /*
                         * What the month would cost somebody nobody has
                         * invoiced yet. "Not billed" with no figure beside it is
                         * the row a warden sees the day after a registration,
                         * and it reads as money that has gone missing; the
                         * amount says the resident is priced and the run simply
                         * has not happened.
                         *
                         * Deliberately in the subtitle rather than in the amount
                         * column on the right. That column is what is *owed*,
                         * every figure in it is summed into the hostel's
                         * outstanding total, and a projection sitting there
                         * would read as a debt the resident does not yet have.
                         */
                        projectedAmount(row)
                          ? `Would be ${formatMoney(projectedAmount(row)!)}`
                          : null,
                        /*
                         * Says so when there is no number, rather than simply
                         * leaving it out: the sheet this opens leads with a call
                         * button, and a row that cannot be called should say so
                         * before it is tapped.
                         *
                         * Truthiness, not `??`: the server sends `phone` as
                         * optional and an empty string reaches here as often as
                         * an absent key.
                         */
                        row.resident.phone
                          ? row.resident.phone
                          : "No phone on file",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                      title={row.resident.fullName || "Unnamed resident"}
                    />
                  ))}

                  {listed.length > visible.length ? (
                    <Card padding="px-4 py-1">
                      <ListRow
                        icon="chevron-down-outline"
                        onPress={() => setShowAll(true)}
                        title={`Show all ${listed.length}`}
                      />
                    </Card>
                  ) : null}
                </View>
              )}
            </View>
          </View>

          {/*
            No chart here, deliberately.

            A bar of the last few months' takings stood at this spot and it was
            removed on 2026-09-02: this screen is a worklist, and the question it
            exists to answer is "who owes money and what do I do about it". A
            trend answers "is this month normal", which is a different and much
            rarer question, and it was the tallest thing on the screen answering
            it — six bars of chrome between the invoice list and the settings row
            that actually gets used.

            The figures are not lost. The month strip carries the count still
            waiting per month, the metric row above carries this month's
            collected and owed, and `manage/reports` draws the monthly series
            properly on a screen somebody opened to look at it.

            `earningsTrend` in `lib/admin-home.ts` is still used by Reports; it
            was the *placement* that was wrong, not the arithmetic.
          */}

          {/*
            A row, not a paragraph and a button.

            This was four lines of prose explaining what Finance is, above a
            secondary button — roughly the shape the references say never to
            use for a destination ("a menu of destinations is an icon-tile grid
            or tinted icon rows, never full-width rows of sentences"). The
            sentence was also doing the button's job: everything it listed is
            just the label of where the row goes.
          */}
          <View className="px-5">
            <Card padding="px-4 py-1">
              <ListRow
                icon="options-outline"
                onPress={() => router.push("/manage/finance")}
                subtitle="Rate card, the monthly billing run, payment details, statements"
                title="Finance settings"
              />
            </Card>
          </View>
        </View>
      </Screen>

      <Sheet
        onClose={() => setOpen(null)}
        open={open !== null}
        title={open?.resident.fullName || "Resident"}
      >
        {open && done ? (
          <View className="items-center gap-3 pb-2 pt-2">
            {done.pending ? (
              <Ionicons color={colors.warning} name="hourglass-outline" size={72} />
            ) : (
              <Lottie loop={false} size={140} source={SUCCESS_ANIMATION} />
            )}
            <Amount size="display" value={done.amount} />
            <Text className="text-center" variant="muted">
              {done.pending
                ? "Saved. Another staff member has to approve it."
                : "Cash collected"}
            </Text>
            <View className="self-stretch pt-2">
              <Button label="Done" onPress={() => setOpen(null)} size="lg" />
            </View>
          </View>
        ) : open ? (
          <View className="gap-4 pb-2">
            <View className="gap-2">
              <View className="flex-row items-center justify-between gap-2">
                <View className="flex-1">
                  <Text variant="label">
                    {open.payment
                      ? /*
                         * Named, not the raw `2026-09` key this printed — and
                         * named in the portal's calendar, like every other month
                         * on the screen. See `hooks/use-dates.ts`.
                         */
                        `${dates.period(open.payment.month)} invoice`
                      : `${dates.period(period)} — not billed`}
                  </Text>
                  <Text variant="caption">
                    {[
                      humanizeEnum(open.resident.roomType),
                      open.resident.roomNumber,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </Text>
                </View>
                <StatusPill status={open.displayStatus} />
              </View>

              {open.payment ? (
                <View className="gap-2 rounded-2xl bg-muted p-4">
                  <View className="flex-row items-end justify-between gap-2">
                    <View>
                      <Text variant="caption">Owing</Text>
                      <Amount owed size="large" value={amountOwed(open)} />
                    </View>
                    <Text variant="caption">
                      {`${formatMoney(open.payment.paidAmount)} of ${formatMoney(open.payment.dueAmount)} paid`}
                    </Text>
                  </View>
                  <Meter
                    animated
                    label={null}
                    percent={
                      open.payment.dueAmount > 0
                        ? Math.round((open.payment.paidAmount / open.payment.dueAmount) * 100)
                        : 100
                    }
                  />
                </View>
              ) : projectedAmount(open) ? (
                /*
                  The unbilled sheet's answer to "how much". One chip, and it
                  says `Would be` rather than `Billed`: the resident is priced,
                  nothing has been invoiced, and the two must not read alike on a
                  screen somebody uses to decide who to ring.
                */
                <View className="flex-row flex-wrap gap-2">
                  <Chip
                    icon="pricetag-outline"
                    label={`Would be ${formatMoney(projectedAmount(open)!)}`}
                  />
                </View>
              ) : null}

              {/*
                And "why". Two of these reasons need somebody to go and price a
                room type, the rest say the run has not happened or that nothing
                is owed — which is the difference between a row to act on and a
                row to leave alone, and the status pill cannot say either.
              */}
              {!open.payment && notBilledReason(open) ? (
                <Text variant="caption">{notBilledReason(open)}</Text>
              ) : null}

              {/*
                The row said "First month"; this says what that did to the
                figure above it. Only when the move-in is past the 1st — a
                resident admitted on the 1st has a first month billed in full,
                and calling that pro-rated would explain a discount they never
                got.
              */}
              {isProRated(open, period) ? (
                <Text variant="caption">
                  {`Part month — billed from ${dates.date(open.resident.moveInDate)}, the day they moved in, so this is less than a full month's rent.`}
                </Text>
              ) : null}

              <View className="flex-row flex-wrap gap-2">
                {open.resident.phone ? (
                  <Chip
                    icon="call-outline"
                    label={open.resident.phone}
                    onPress={() =>
                      void Linking.openURL(`tel:${open.resident.phone}`)
                    }
                    tone="brand"
                  />
                ) : null}
                <Chip
                  icon="person-outline"
                  label="Open their record"
                  onPress={() => {
                    const residentId = open.resident.id;

                    setOpen(null);
                    router.push(`/manage/resident/${residentId}`);
                  }}
                />
              </View>
            </View>

            {open.payment ? (
              <>
                {open.payment.lines?.some((line) => line.basis === "FINE" || line.basis === "KHATA") ? (
                  <View className="gap-2">
                    <BillExtras lines={open.payment.lines} />
                    {open.payment.status !== "PAID" &&
                    open.payment.lines.some((line) => line.basis === "FINE") ? (
                      <View className="flex-row">
                        <Chip icon="close-circle-outline" label="Waive fine" onPress={waiveFine} />
                      </View>
                    ) : null}
                  </View>
                ) : null}
                <View className="gap-3 border-t border-border pt-4">
                  <Input
                    keyboardType="number-pad"
                    label="Cash received"
                    leading={<Text variant="subtitle">Rs</Text>}
                    onChangeText={(amount) => {
                      setCash((prev) => ({ ...prev, amount: amount.replace(/\D/g, "") }));
                      setCashError(null);
                    }}
                    placeholder="0"
                    style={{ fontSize: 22, fontWeight: "700" }}
                    value={cash.amount}
                  />
                  {amountOwed(open) > 1 ? (
                    <View className="flex-row flex-wrap gap-2">
                      {[
                        { label: "Full", value: amountOwed(open) },
                        { label: "Half", value: Math.round(amountOwed(open) / 2) },
                      ].map((pick) => (
                        <Chip
                          key={pick.label}
                          label={`${pick.label} · ${formatMoney(pick.value)}`}
                          onPress={() => {
                            setCash((prev) => ({ ...prev, amount: String(pick.value) }));
                            setCashError(null);
                          }}
                          tone={cash.amount === String(pick.value) ? "brand" : "neutral"}
                        />
                      ))}
                    </View>
                  ) : null}

                  {editCollector ? (
                    <Input
                      label="Collected by"
                      onChangeText={(collectedBy) =>
                        setCash((prev) => ({ ...prev, collectedBy }))
                      }
                      placeholder="Name of who took the cash"
                      value={cash.collectedBy}
                    />
                  ) : (
                    <Card padding="px-4 py-1">
                      <CardRow
                        left={
                          <PersonAvatar
                            image={cash.collectedBy === me ? account?.image : null}
                            name={cash.collectedBy}
                            size="sm"
                          />
                        }
                        onPress={() => setEditCollector(true)}
                        right={
                          <Text className="text-primary" variant="label">
                            Change
                          </Text>
                        }
                        subtitle={
                          cash.collectedBy === me && account
                            ? `Collected by · ${readableRole(account.role)}`
                            : "Collected by"
                        }
                        title={cash.collectedBy}
                      />
                    </Card>
                  )}

                  {showNote ? (
                    <Input
                      label="Note"
                      onChangeText={(note) => setCash((prev) => ({ ...prev, note }))}
                      placeholder="Optional"
                      value={cash.note}
                    />
                  ) : (
                    <View className="flex-row">
                      <Chip
                        icon="create-outline"
                        label="Add a note"
                        onPress={() => setShowNote(true)}
                      />
                    </View>
                  )}

                  {cashError ? (
                    <Text className="text-destructive" variant="label">
                      {cashError}
                    </Text>
                  ) : null}
                  <Button
                    disabled={busy === "void"}
                    icon={Banknote}
                    label={
                      Number(cash.amount) > 0
                        ? `Collect ${formatMoney(Number(cash.amount))}`
                        : "Collect cash"
                    }
                    loading={busy === "cash"}
                    onPress={() => void takeCash()}
                    size="lg"
                  />
                </View>

                {/* Rare and irreversible, so it stays folded away. */}
                <View className="border-t border-border pt-1">
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ expanded: voidOpen }}
                    className="flex-row items-center justify-between py-3"
                    onPress={() => setVoidOpen((value) => !value)}
                  >
                    <Text variant="muted">Void this invoice</Text>
                    <Ionicons
                      color={colors.mutedForeground}
                      name={voidOpen ? "chevron-up" : "chevron-down"}
                      size={18}
                    />
                  </Pressable>
                  {voidOpen ? (
                    <View className="gap-3">
                      <Input
                        error={voidError}
                        hint="The resident sees this reason."
                        label="Reason"
                        multiline
                        onChangeText={(reason) => {
                          setVoidReason(reason);
                          setVoidError(null);
                        }}
                        placeholder="Billed by mistake"
                        style={{ height: 72 }}
                        value={voidReason}
                      />
                      <Button
                        disabled={busy === "cash"}
                        label="Void invoice"
                        loading={busy === "void"}
                        onPress={() => void voidIt()}
                        variant="danger"
                      />
                    </View>
                  ) : null}
                </View>
              </>
            ) : (
              <Text variant="muted">
                Nothing has been billed to this person for this month, so there
                is nothing to take cash against. Run billing from the Finance
                screen.
              </Text>
            )}
          </View>
        ) : null}
      </Sheet>

      {actions.sheet}
    </>
  );
}

/**
 * With Overall picked in the switcher this tab answers for every branch at
 * once (`components/overall-views.tsx`); otherwise it is the one branch's screen.
 */
export default function AdminMoneyScreen() {
  return useIsOverall() ? <OverallTabScreen tab="money" /> : <BranchAdminMoneyScreen />;
}
