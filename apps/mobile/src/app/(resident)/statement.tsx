import { router } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { Pressable, Share, TextInput, View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Badge, StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Glyph } from "@/components/ui/glyph";
import { Input } from "@/components/ui/input";
import { FactRow } from "@/components/ui/layout";
import { Money } from "@/components/ui/money";
import { Screen } from "@/components/ui/screen";
import { Sheet } from "@/components/ui/sheet";
import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { WalletMark } from "@/components/ui/wallet-mark";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { readApiError } from "@/lib/api-contract";
import type { CalendarSystem } from "@/lib/calendar";
import { downloadToDevice } from "@/lib/documents";
import { type ResidentFinanceView, statementPdfUrl } from "@/lib/finance-api";
import { formatMoney, formatTime, humanizeEnum } from "@/lib/format";
import {
  activeFilterCount,
  activeQuickRange,
  filterCredits,
  groupByDay,
  isPartial,
  methodOptions,
  NO_FILTER,
  quickRange,
  QUICK_RANGES,
  rangeLabel,
  type StatementFilter,
  statementSummary,
  statusOptions,
  visibleTotal,
} from "@/lib/hostel-statement";
import { residentQuery } from "@/lib/resident-queries";
import {
  debitTitle,
  residentStatementShareText,
  type StatementDebit,
  statementDebits,
} from "@/lib/resident-statement";
import { toastError } from "@/lib/toast";

/**
 * The resident's statement — what has gone out, for what, and when.
 *
 * ## The tab it replaced
 *
 * Food. Which is a screen a resident opens to read this week's menu, and which
 * Home already leads with — today's meals sit on the dashboard with `All meals`
 * on them, so the tab was a second way to reach something already in front of
 * them. What was *not* reachable in one tap was the answer to "what have I
 * actually paid": the Payments tab is a list of months and what is open on them,
 * built around paying the next one. A resident asked by a parent, a guardian or
 * a landlord what they have paid had to read a list of debts to work it out.
 *
 * The Food screen is unchanged and still reachable from Home and from More — the
 * same way Notices was kept when Community took its slot.
 *
 * ## The hostel's statement, read from the other side
 *
 * The same screen as `app/manage/finance/statement.tsx`, to the point: the
 * painted bar with the summary card straddling it, the sticky search field, the
 * collapse pill on the hairline, the day groups with the heading outside the
 * card, the filter sheet and the detail sheet. Everything that filters,
 * searches, groups and totals is literally the same code — see
 * `lib/hostel-statement.ts` — so a fix to either lands on both.
 *
 * What differs is the direction, and therefore the words. Every row here is a
 * **debit**: money the resident paid, drawn red with a downward caret against
 * the hostel side's green and up, `Total paid` rather than `Total received`. The
 * red is the wallet vocabulary of the reference apps, not an alarm — see
 * `<Money>`'s `tone`.
 *
 * The per-row action pill differs too. The hostel's is `Resident`, because on
 * that side the person is what a row is about; here every row is the same
 * person, so the pill opens the **invoice** — the thing with the receipt on it.
 *
 * ## Export is one tap, not a format sheet
 *
 * The hostel's export asks PDF or spreadsheet, because an owner reconciles
 * against a spreadsheet and hands a bank a PDF. A resident has one audience for
 * this document — whoever is asking them to prove they paid — and one server
 * route behind it, `GET /resident/finance/statement/pdf`. So the button
 * downloads, and a sheet with a single row in it would be a tap charged for
 * nothing.
 *
 * ## The read is already warm
 *
 * `residentQuery.finance()` is the same descriptor the Payments tab holds and
 * the same one `prefetchResidentPortal` warms at the door, so this tab costs no
 * request at all — it paints from the cache the portal filled on the way in.
 */

/** How far the summary card rides up onto the painted bar, in points. */
const STRADDLE = 26;

/** The diameter of the pill that collapses the range chips. */
const PILL = 30;

/** The search field's height. A style, not `h-[46px]` — see `<AdminSearchBar>`. */
const FIELD_HEIGHT = 46;

/*
 * `METHOD_ICONS` and `methodIcon` stood here.
 *
 * A table mapping each channel to an Ionicon, with a comment explaining that a
 * glyph "carries what a brand logo would" because the repo had none. It also
 * gave **eSewa and Khalti the same glyph** — `phone-portrait` — so on a
 * ledger of a resident's own payments the two wallets they actually use were
 * indistinguishable pictures.
 *
 * The marks arrived on 2026-09-05. `<WalletMark>` draws the real one and keeps
 * the tinted glyph tile as the fallback for bank and cash, so the direction tone
 * these rows depend on survives.
 */

/** A chip that is a **choice**, not a fact. See the hostel statement's copy. */
function FilterChip({
  label,
  onPress,
  selected,
}: {
  label: string;
  onPress: () => void;
  selected: boolean;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      className={`rounded-full border px-3.5 py-2 active:opacity-70 ${
        selected ? "border-primary bg-primary" : "border-border bg-card"
      }`}
      onPress={() => {        onPress();
      }}
    >
      <Text
        className={`text-xs font-semibold ${
          selected ? "text-primary-foreground" : "text-foreground"
        }`}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** A labelled wrap of chips — the sheet's one repeating shape. */
function ChipGroup({
  onChange,
  options,
  title,
  value,
}: {
  onChange: (next: string) => void;
  /** Server enums. `All` is prepended here rather than by every caller. */
  options: readonly string[];
  title: string;
  /** `""` is `All`. */
  value: string;
}) {
  return (
    <View className="gap-2">
      <Text variant="label">{title}</Text>
      <View className="flex-row flex-wrap gap-2">
        <FilterChip label="All" onPress={() => onChange("")} selected={value === ""} />
        {options.map((option) => (
          <FilterChip
            key={option}
            label={humanizeEnum(option)}
            onPress={() => onChange(option)}
            selected={value === option}
          />
        ))}
      </View>
    </View>
  );
}

/** The way back to the whole statement, one tap from wherever a filter was set. */
function ClearFilters({ count, onPress }: { count: number; onPress: () => void }) {
  const { colors } = useAppTheme();

  return (
    <Pressable
      accessibilityLabel={count === 1 ? "Clear 1 filter" : `Clear ${count} filters`}
      accessibilityRole="button"
      className="flex-row items-center gap-1 rounded-full px-2 py-1.5 active:opacity-60"
      hitSlop={6}
      onPress={onPress}
    >
      <Glyph color={colors.mutedForeground} name="close-circle" size={14} />
      <Text className="text-xs font-semibold text-muted-foreground">Clear</Text>
    </Pressable>
  );
}

/** The small-caps label over a figure — the reference's `BALANCE`. */
function MicroLabel({ children }: { children: string }) {
  return (
    <Text
      className="font-semibold uppercase tracking-wider text-muted-foreground"
      style={{ fontSize: 10 }}
    >
      {children}
    </Text>
  );
}

/**
 * One debit.
 *
 * Anatomy straight from the reference, and identical to the hostel's
 * `<CreditRow>` bar the direction: a tinted glyph tile, the title over its clock
 * time, the signed amount hard right, and a footer carrying the running total
 * against a single action pill. The reference's `REDO` slot is the one per-row
 * shortcut worth a tap, and for a resident that is the invoice this money
 * settled — where the receipt is.
 */
function DebitRow({
  calendar,
  debit,
  onInvoice,
  onOpen,
}: {
  /*
   * Passed down rather than read from `useDates()` here, the same call the
   * hostel's row makes: this renders once per debit, and the title has to be
   * spelled in the same calendar as the headings above it.
   */
  calendar: CalendarSystem;
  debit: StatementDebit;
  onInvoice: () => void;
  onOpen: () => void;
}) {
  const { colors } = useAppTheme();

  return (
    <Pressable
      accessibilityLabel={`${debitTitle(debit, calendar)}, ${formatMoney(debit.amount)} paid`}
      accessibilityRole="button"
      className="active:opacity-80"
      onPress={onOpen}
    >
      <Card className="gap-3">
        <View className="flex-row items-start gap-3">
          {/*
            The wallet's own mark, falling back to the tinted glyph tile for a
            method that has none. eSewa and Khalti both mapped to
            `phone-portrait`, so the two wallets a resident actually
            uses were the same picture on a ledger of their own payments.
          */}
          <WalletMark name={debit.method} size={40} square tone="danger" />

          <View className="flex-1 gap-1">
            <Text numberOfLines={2} variant="label">
              {debitTitle(debit, calendar)}
            </Text>
            <View className="flex-row flex-wrap items-center gap-2">
              <Text variant="caption">{formatTime(debit.receivedAt)}</Text>
              {isPartial(debit) ? <Badge label="Part payment" tone="warning" /> : null}
            </View>
          </View>

          {/*
            The direction marker is a constant on this screen, and it is still
            drawn. It is what makes a row legible as *money out* at a glance
            without reading the label — the same job the red triangle does in the
            reference.
          */}
          <View className="flex-row items-center gap-1 pt-0.5">
            <Glyph color={colors.destructive} name="caret-down" size={12} />
            <Money tone="debit" value={debit.amount} />
          </View>
        </View>

        <View className="flex-row items-end justify-between gap-3 border-t border-border pt-3">
          <View className="shrink gap-0.5">
            <MicroLabel>Total paid</MicroLabel>
            {/*
              Always a figure, never the hostel side's dash. That dash is for a
              truncated ledger, and a resident's own history is a row a month —
              the whole of it always arrives. See `lib/resident-statement.ts`.
            */}
            <Money value={debit.runningTotal} />
          </View>

          <Pressable
            accessibilityLabel="Open this invoice"
            accessibilityRole="button"
            className="rounded-lg bg-brand-soft px-3 py-2 active:opacity-70"
            hitSlop={6}
            onPress={onInvoice}
          >
            <Text className="text-xs font-bold uppercase tracking-wide text-primary">
              Invoice
            </Text>
          </Pressable>
        </View>
      </Card>
    </Pressable>
  );
}

export default function ResidentStatementScreen() {
  const dates = useDates();
  const { colors } = useAppTheme();

  const query = residentQuery.finance();
  const finance = useResource<ResidentFinanceView>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  /** What the list is actually filtered by. */
  const [filter, setFilter] = useState<StatementFilter>(NO_FILTER);
  /**
   * The sheet's working copy.
   *
   * The sheet has an `APPLY` button, so its controls must not filter the list
   * behind it as they are touched — a list rebuilding under a half-made choice
   * is what makes people close the sheet to see what they did. The quick ranges
   * in the header apply immediately, because they *are* the whole choice.
   */
  const [draft, setDraft] = useState<StatementFilter>(NO_FILTER);
  const [filterOpen, setFilterOpen] = useState(false);
  /* Collapsed to start with — a filter is something you go looking for, and the
     pill on the hairline is where it is found. */
  const [rangesOpen, setRangesOpen] = useState(false);
  const [open, setOpen] = useState<StatementDebit | null>(null);
  const [exporting, setExporting] = useState(false);

  const debits = useMemo(() => statementDebits(finance.data), [finance.data]);
  const visible = useMemo(() => filterCredits(debits, filter), [debits, filter]);
  const days = useMemo(() => groupByDay(visible), [visible]);
  const summary = useMemo(
    () => statementSummary(debits, dates.calendar),
    [dates.calendar, debits],
  );
  const methods = useMemo(() => methodOptions(debits), [debits]);
  const statuses = useMemo(() => statusOptions(debits), [debits]);
  /**
   * Everything this resident has ever paid this hostel.
   *
   * Over `debits` rather than `visible`, the same call the month underneath it
   * makes: the list is whatever the filters left behind, and a headline that
   * moves when a chip is tapped is a headline nobody can quote. This is the
   * figure somebody is being asked for when they open the screen at all.
   *
   * The newest row's `runningTotal` is the same number by construction, and this
   * does not read it — a headline that goes blank when the list is empty, or
   * when a filter hides the top row, would be the whole point of the card lost
   * to an indexing detail.
   */
  const paidTotal = useMemo(() => visibleTotal(debits), [debits]);

  const filterCount = activeFilterCount(filter);
  const activeRange = activeQuickRange(filter);
  /** Whether there is a real statement behind the header's share button. */
  const shareable = !finance.loading && !finance.error && finance.data !== null;

  const share = useCallback(async () => {
    try {
      await Share.share({
        message: residentStatementShareText({
          calendar: dates.calendar,
          debits: visible,
          filter,
        }),
      });
    } catch (error) {
      toastError("Could not share", readApiError(error, "The share sheet did not open."));
    }
  }, [dates.calendar, filter, visible]);

  /**
   * Downloads the statement the server renders.
   *
   * Not a document built here from `visible`. A paper that says "statement" is
   * shown to somebody who wants proof, and the server's is the one the hostel
   * would recognise — a second, client-side rendering of the same figures is a
   * second thing to keep right, and the first one to be wrong.
   *
   * `downloadToDevice` rather than a share sheet, and no spinner of its own:
   * progress goes to the global toaster and the notification shade. `exporting`
   * exists only to stop a second tap.
   */
  const exportPdf = useCallback(async () => {
    setExporting(true);

    try {
      await downloadToDevice({
        extension: "pdf",
        fileName: "hostel-statement",
        label: "Statement",
        mimeType: "application/pdf",
        url: statementPdfUrl(),
      });
    } catch (error) {
      toastError("Could not export", readApiError(error, "The statement did not download."));
    } finally {
      setExporting(false);
    }
  }, []);

  const clearFilters = useCallback(() => {    setFilter(NO_FILTER);
  }, []);

  const openFilters = useCallback(() => {
    setDraft(filter);
    setFilterOpen(true);
  }, [filter]);

  const setRange = useCallback((days: number) => {
    // Tapping the live chip clears it, so the control can undo itself without a
    // fourth "All" chip that would only ever mean "not the other three".
    setFilter((current) =>
      activeQuickRange(current) === days
        ? { ...current, from: "", to: "" }
        : { ...current, ...quickRange(days) },
    );
  }, []);

  /* ---------------------------------------------------------------- header */

  const header = (
    <View className="bg-background">
      <AppBar
        accent
        actions={
          <View className="flex-row items-center gap-1">
            {/*
              Off until there is a statement to describe. The share text over an
              empty list is a well-formed "0 payments · Rs 0 paid", and sending
              that from a screen that is still loading — or that failed to load
              at all — puts a figure in somebody's thread that is not a fact.
            */}
            <Pressable
              accessibilityLabel="Share this statement"
              accessibilityRole="button"
              className={`h-10 w-10 items-center justify-center rounded-full active:opacity-70 ${
                shareable ? "" : "opacity-40"
              }`}
              disabled={!shareable}
              hitSlop={4}
              onPress={() => void share()}
            >
              <Glyph color={colors.primaryForeground} name="share-social" size={20} />
            </Pressable>

            <Pressable
              accessibilityLabel="Download this statement"
              accessibilityRole="button"
              className={`h-10 w-10 items-center justify-center rounded-full active:opacity-70 ${
                exporting ? "opacity-50" : ""
              }`}
              disabled={exporting}
              hitSlop={4}
              onPress={() => void exportPdf()}
            >
              <Glyph color={colors.primaryForeground} name="document-text" size={20} />
            </Pressable>
          </View>
        }
        /*
          The bar reserves exactly the room the card below takes back, so the
          card lands where the bar would otherwise have ended and the title row
          stays clear above it.
        */
        straddle={STRADDLE}
        subtitle="Money paid"
        title="Statement"
      />

      {/*
        The straddle — NOTES §1. It rides up onto the bar's rounded bottom rather
        than sitting under it, which is what turns two stacked strips into one
        header with an object on its edge. The shadow is what sells it; without
        one the card reads as a hole cut in the paint.
      */}
      <View className="px-5" style={{ marginTop: -STRADDLE }}>
        <Pressable
          accessibilityHint="Opens your payments"
          accessibilityLabel={`${formatMoney(paidTotal)} paid in total, ${formatMoney(
            summary.total,
          )} of it in ${summary.periodLabel}`}
          accessibilityRole="button"
          className="flex-row items-center gap-3 rounded-2xl border border-border bg-card p-3 active:opacity-80"
          onPress={() => router.push("/(resident)/payments")}
          style={{
            elevation: 8,
            shadowColor: "#000000",
            shadowOffset: { height: 6, width: 0 },
            shadowOpacity: 0.13,
            shadowRadius: 16,
          }}
        >
          <View className="h-10 w-10 items-center justify-center rounded-2xl bg-brand-soft">
            <Glyph color={colors.primary} name="stats-chart" size={18} />
          </View>

          {/*
            The lifetime figure on the line, the month under it.

            The hostel's card leads with its month, because an owner is
            reconciling *this* month's collection against their own cash box. A
            resident is not reconciling anything — they are being asked what they
            have paid, usually by somebody who wants the whole of it, so the
            total is the headline and the month is the context for it.

            Both are skeletons until the invoices land, never the zeroed figure.
            "Rs 0 paid in total" is perfectly well-formed, and on a slow
            connection a resident reads it as a hostel that has no record of
            them — a lie the screen tells for as long as the request runs. The
            whole reason this app loads into skeletons is that a placeholder
            cannot be misread as data.
          */}
          <View className="flex-1 gap-1">
            {finance.loading ? (
              <>
                <Skeleton height={14} width="72%" />
                <Skeleton height={10} width="45%" />
              </>
            ) : (
              <>
                <Text numberOfLines={1} variant="label">
                  {`${formatMoney(paidTotal)} paid in total`}
                </Text>
                <Text numberOfLines={1} variant="caption">
                  {`${formatMoney(summary.total)} in ${summary.periodLabel} · What you owe`}
                </Text>
              </>
            )}
          </View>

          <Glyph color={colors.mutedForeground} name="chevron-forward" size={18} />
        </Pressable>
      </View>

      <View className="gap-3 px-5 pb-3 pt-4">
        <View className="flex-row items-center gap-2">
          <View
            className="flex-1 flex-row items-center gap-2 rounded-2xl border border-border bg-card"
            style={{ height: FIELD_HEIGHT, paddingLeft: 14, paddingRight: 12 }}
          >
            {/*
              A bare `TextInput`, not `<Input>`: that one carries a label, its own
              border and its own height, all of which fight a field that is meant
              to read as part of the header.
            */}
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              className="h-full flex-1 text-base text-foreground"
              onChangeText={(query) => setFilter((current) => ({ ...current, query }))}
              placeholder="Search this statement"
              placeholderTextColor={colors.mutedForeground}
              returnKeyType="search"
              value={filter.query}
            />

            {filter.query ? (
              <Pressable
                accessibilityLabel="Clear search"
                accessibilityRole="button"
                hitSlop={8}
                onPress={() => setFilter((current) => ({ ...current, query: "" }))}
              >
                <Glyph color={colors.mutedForeground} name="close-circle" size={16} />
              </Pressable>
            ) : (
              <Glyph color={colors.mutedForeground} name="search" size={16} />
            )}
          </View>

          {/* The reference's hairline between the field and the filter glyph. */}
          <View className="h-6 w-px bg-border" />

          <Pressable
            accessibilityLabel={
              filterCount === 0
                ? "Filter the statement"
                : `Filter the statement, ${filterCount} on`
            }
            accessibilityRole="button"
            className="h-10 w-10 items-center justify-center rounded-full active:opacity-70"
            hitSlop={6}
            onPress={openFilters}
          >
            <Glyph color={colors.foreground} name="options" size={21} />

            {filterCount > 0 ? (
              <View
                className="absolute -right-0.5 -top-0.5 h-[18px] items-center justify-center rounded-full bg-primary px-1"
                // A style rather than `min-w-[18px]` — see the note in `<CardRow>`.
                style={{ minWidth: 18 }}
              >
                <Text className="text-[10px] font-bold text-primary-foreground">
                  {filterCount}
                </Text>
              </View>
            ) : null}
          </Pressable>
        </View>

        {rangesOpen ? (
          <View className="flex-row flex-wrap items-center gap-2">
            {QUICK_RANGES.map((days) => (
              <FilterChip
                key={days}
                label={`${days} days`}
                onPress={() => setRange(days)}
                selected={activeRange === days}
              />
            ))}

            {filterCount > 0 ? (
              <ClearFilters count={filterCount} onPress={clearFilters} />
            ) : null}
          </View>
        ) : filterCount > 0 ? (
          /*
            The strip is shut and something is still filtering the list. Without
            this line the only sign would be the small badge on the filter glyph,
            and the way out would be inside the sheet.
          */
          <View className="flex-row items-center gap-2">
            <Text className="flex-1" numberOfLines={1} variant="caption">
              {filterCount === 1 ? "1 filter on" : `${filterCount} filters on`}
            </Text>
            <ClearFilters count={filterCount} onPress={clearFilters} />
          </View>
        ) : null}
      </View>

      <View className="h-px bg-border" />

      {/*
        The pill that straddles the hairline — the reference's collapse control,
        and NOTES §1's "something straddling the bottom edge" at the point where
        the header stops and the list begins. Half of it hangs into the list, so
        the container contributes only its bottom half to the layout.
      */}
      <View className="items-center" style={{ height: PILL, marginTop: -PILL / 2 }}>
        <Pressable
          accessibilityLabel={
            rangesOpen
              ? "Hide the quick ranges"
              : filterCount > 0
                ? `Show the quick ranges, ${filterCount} filter(s) on`
                : "Show the quick ranges"
          }
          accessibilityRole="button"
          className="items-center justify-center rounded-full bg-primary active:opacity-80"
          hitSlop={10}
          onPress={() => {            setRangesOpen((value) => !value);
          }}
          style={{ height: PILL, width: PILL }}
        >
          <Glyph
            color={colors.primaryForeground}
            name={rangesOpen ? "chevron-up" : "chevron-down"}
            size={16}
          />
        </Pressable>
      </View>
    </View>
  );

  /* ------------------------------------------------------------------ body */

  if (finance.error) {
    return (
      <Screen header={header} insideTabs>
        <ErrorState message={finance.error} onRetry={finance.reload} />
      </Screen>
    );
  }

  return (
    <>
      <Screen
        header={header}
        insideTabs
        onRefresh={finance.refresh}
        padded={false}
        refreshing={finance.refreshing}
        scroll
      >
        <View className="gap-5 px-5 pt-4">
          {finance.loading ? <SkeletonRows rows={6} /> : null}

          {!finance.loading && filterCount > 0 && visible.length > 0 ? (
            <Text variant="muted">
              {`${visible.length === 1 ? "1 payment" : `${visible.length} payments`} · ${formatMoney(
                visibleTotal(visible),
              )} · ${rangeLabel(filter, dates.calendar)}`}
            </Text>
          ) : null}

          {!finance.loading && visible.length === 0 ? (
            filterCount > 0 ? (
              <EmptyCard
                action={
                  <Button
                    label="Clear filters"
                    onPress={() => setFilter(NO_FILTER)}
                    size="sm"
                    variant="outline"
                  />
                }
                description="Nothing in your statement matches what you asked for."
                title="No payments here"
              />
            ) : (
              <EmptyCard
                description="Every payment you make lands here the moment your hostel records or verifies it."
                title="Nothing paid yet"
              />
            )
          ) : null}

          {days.map((day) => (
            <View className="gap-3" key={day.key}>
              {/*
                The heading sits on the page, outside the cards — NOTES §5. It
                carries the day's own total on the right, which the reference
                does not: a statement grouped by day and silent about what each
                day came to is making the reader add the column up.
              */}
              <View className="flex-row items-end justify-between gap-3">
                <Text
                  className="shrink font-semibold uppercase tracking-wider text-muted-foreground"
                  numberOfLines={1}
                  style={{ fontSize: 11 }}
                >
                  {day.label}
                </Text>
                <Text className="text-xs font-semibold text-muted-foreground">
                  {formatMoney(day.total)}
                </Text>
              </View>

              {day.rows.map((debit) => (
                <DebitRow
                  calendar={dates.calendar}
                  debit={debit}
                  key={debit.id}
                  onInvoice={() => router.push(`/invoice/${debit.id}`)}
                  onOpen={() => setOpen(debit)}
                />
              ))}
            </View>
          ))}
        </View>
      </Screen>

      {/* --------------------------------------------------------- detail */}
      <Sheet
        footer={
          open ? (
            <View className="flex-row gap-3">
              <View className="flex-1">
                <Button
                  label="Open invoice"
                  onPress={() => {
                    const invoiceId = open.id;

                    setOpen(null);
                    router.push(`/invoice/${invoiceId}`);
                  }}
                  variant="outline"
                />
              </View>
              <View className="flex-1">
                <Button label="Done" onPress={() => setOpen(null)} />
              </View>
            </View>
          ) : undefined
        }
        onClose={() => setOpen(null)}
        open={open !== null}
        title="Payment details"
      >
        {open ? (
          <View className="gap-4 pb-2">
            <View className="flex-row items-start gap-3">
              <WalletMark name={open.method} size={44} square tone="danger" />

              <View className="flex-1 gap-1">
                <Text variant="subtitle">{debitTitle(open, dates.calendar)}</Text>
                <Text variant="caption">{dates.dateTime(open.receivedAt)}</Text>
              </View>
            </View>

            <View className="flex-row items-center justify-between gap-3">
              <Money size="large" tone="debit" value={open.amount} />
              <StatusPill status={open.status} />
            </View>

            {/*
              A label/value grid, not a table — NOTES §8. The pairs are ordered
              the way somebody checks a payment: what left against what was
              asked, then when, then how, then what it was for.
            */}
            <View className="gap-0 border-t border-border pt-1">
              <FactRow label="Paid" value={formatMoney(open.amount)} />
              <FactRow label="Billed" value={formatMoney(open.billed)} />
              {isPartial(open) ? (
                <FactRow label="Still owed" value={formatMoney(open.billed - open.amount)} />
              ) : null}
              <FactRow label="Paid on" value={dates.date(open.receivedAt)} />
              <FactRow label="Method" value={humanizeEnum(open.method)} />
              <FactRow
                label="For"
                value={open.period ? dates.period(open.period) : "A one-off charge"}
              />
              {open.dueDate ? (
                <FactRow label="Was due" value={dates.date(open.dueDate)} />
              ) : null}
              {/*
                The code the hostel matches a bank transfer by. It is on the row
                only when the invoice carries one — migrated history predates
                them — and it is the first thing to quote when a payment has to
                be traced.
              */}
              {open.referenceCode ? (
                <FactRow label="Reference" value={open.referenceCode} />
              ) : null}
              <FactRow label="Total paid" value={formatMoney(open.runningTotal)} />
              {/*
                The reference's "Transaction Code". Ours is the invoice id — the
                only identifier that exists on both sides of a support call, and
                the thing to quote if the hostel says the money never arrived.
              */}
              <FactRow label="Invoice" value={open.id} />
            </View>
          </View>
        ) : null}
      </Sheet>

      {/* --------------------------------------------------------- filters */}
      <Sheet
        footer={
          <View className="flex-row items-center gap-3">
            <View className="flex-1">
              <Button label="Reset" onPress={() => setDraft(NO_FILTER)} variant="ghost" />
            </View>
            <View className="flex-1">
              <Button
                label="Apply"
                onPress={() => {
                  /*
                    The header's search box keeps its own value: it is outside
                    the sheet and visible behind it, so applying a draft that
                    carried a stale `query` would silently rewrite a field the
                    reader can see.
                  */
                  setFilter((current) => ({ ...draft, query: current.query }));
                  setFilterOpen(false);
                }}
              />
            </View>
          </View>
        }
        onClose={() => setFilterOpen(false)}
        open={filterOpen}
        title="Statement filter"
      >
        <View className="gap-5 pb-2">
          {/*
            Both groups are built from the invoices rather than from the enum. A
            resident who has only ever paid in cash would otherwise get five
            chips that filter to nothing, and a control whose options are mostly
            dead teaches people not to open it. See `methodOptions`.
          */}
          <ChipGroup
            onChange={(status) => setDraft((current) => ({ ...current, status }))}
            options={statuses}
            title="Status"
            value={draft.status}
          />

          <ChipGroup
            onChange={(method) => setDraft((current) => ({ ...current, method }))}
            options={methods}
            title="How it was paid"
            value={draft.method}
          />

          <View className="gap-2">
            <Text variant="label">Date</Text>

            <View className="flex-row gap-3">
              <View className="flex-1">
                <Input
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="numbers-and-punctuation"
                  label="From"
                  onChangeText={(from) => setDraft((current) => ({ ...current, from }))}
                  placeholder="YYYY-MM-DD"
                  value={draft.from}
                />
              </View>
              <View className="flex-1">
                <Input
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="numbers-and-punctuation"
                  label="To"
                  onChangeText={(to) => setDraft((current) => ({ ...current, to }))}
                  placeholder="YYYY-MM-DD"
                  value={draft.to}
                />
              </View>
            </View>

            {/*
              A typed field with quick chips, not a wheel picker. `docs/DESIGN.md`
              rules out building a date picker, and every other date in the app
              already made this call: three taps and a modal for something a
              person can type in.
            */}
            <View className="flex-row flex-wrap gap-2">
              {QUICK_RANGES.map((days) => (
                <FilterChip
                  key={days}
                  label={`${days} days`}
                  onPress={() => setDraft((current) => ({ ...current, ...quickRange(days) }))}
                  selected={activeQuickRange(draft) === days}
                />
              ))}
              <FilterChip
                label="All time"
                onPress={() => setDraft((current) => ({ ...current, from: "", to: "" }))}
                selected={draft.from === "" && draft.to === ""}
              />
            </View>
          </View>

          <Input
            hint="Hides anything smaller. Leave it empty for everything."
            keyboardType="number-pad"
            label="At least (Rs)"
            onChangeText={(minAmount) => setDraft((current) => ({ ...current, minAmount }))}
            placeholder="e.g. 5000"
            value={draft.minAmount}
          />
        </View>
      </Sheet>
    </>
  );
}
