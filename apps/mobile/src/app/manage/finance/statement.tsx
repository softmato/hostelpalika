import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { Pressable, Share, TextInput, View } from "react-native";

import { openInBranch, useIsOverall } from "@/components/hostel-switcher";
import { AppBar } from "@/components/ui/app-bar";
import { Badge, StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { FactRow } from "@/components/ui/layout";
import { Money } from "@/components/ui/money";
import { Screen } from "@/components/ui/screen";
import { Sheet, SheetRow } from "@/components/ui/sheet";
import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { WalletMark } from "@/components/ui/wallet-mark";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useDates } from "@/hooks/use-dates";
import type { CalendarSystem } from "@/lib/calendar";
import { useResource } from "@/hooks/use-resource";
import { type AdminHostel, type AdminLedger } from "@/lib/admin-api";
import { overallPdfPath } from "@/lib/admin-manage-api";
import { adminQuery } from "@/lib/admin-queries";
import { API_BASE_URL } from "@/lib/api";
import { readApiError } from "@/lib/api-contract";
import { downloadToDevice } from "@/lib/documents";
import {
  formatMoney,
  formatTime,
  humanizeEnum,
  nepalPeriodKey,
} from "@/lib/format";
import {
  activeFilterCount,
  activeMonthRange,
  activeQuickRange,
  creditTitle,
  directionOptions,
  filterCredits,
  groupByDay,
  isPartial,
  methodOptions,
  monthOptions,
  monthRange,
  NO_FILTER,
  quickRange,
  QUICK_RANGES,
  rangeLabel,
  type StatementCredit,
  statementCredits,
  type StatementFilter,
  statementShareText,
  statementSummary,
  splitTotals,
  statusOptions,
  visibleTotal,
} from "@/lib/hostel-statement";
import { toastError } from "@/lib/toast";

/**
 * The hostel statement — what has come in, from whom, and when.
 *
 * ## What this screen is, and what it is not
 *
 * It is the hostel's ledger: every rupee that has actually arrived (credits)
 * and, for the owner, every rupee recorded as spent (debits), newest first,
 * grouped by the day it moved. It is deliberately not the Money tab,
 * which answers the opposite question — who still owes — and it is deliberately
 * not `manage/statements`, which is the *reconciliation* screen where a bank or
 * wallet export is imported and matched. Three screens, three questions; the
 * near-identical names are unfortunate and the routes are not interchangeable.
 *
 * ## Credits and debits, signed by colour
 *
 * The wallet apps this layout comes from list debits and credits together and
 * sign them by colour, and since expenses (docs/EXPENSES_PLAN.md) this one does
 * too: money in is green with an up caret, money out is `<Money tone="debit">`
 * with a down caret, and the running figure is the net balance. A warden gets
 * no expenses on the wire, so their statement stays credits only. See the head
 * of `lib/hostel-statement.ts`.
 *
 * ## The shape is the reference's, the colour is ours
 *
 * Straight out of `ui_inspiration_folder/app_recordings/NOTES.md`, and each of
 * these is a rule from that file rather than a choice made here:
 *
 * - §1 a painted block with rounded bottom corners, with the summary card
 *   **straddling** its edge;
 * - §5 the list groups by date with the heading **outside** the card;
 * - §7 the filters are labelled chip groups in a sheet with `RESET` and `APPLY`;
 * - §8 the detail is a label/value grid, which is `<FactRow>`;
 * - §9 loading is skeleton cards, not a spinner.
 *
 * What was not taken is the palette. The reference's lime green and dark ground
 * are not ours; the accent here is `--primary` and the ground is the page.
 *
 * ## The header does not scroll
 *
 * It is the `Screen`'s `header`, so the search field and the range chips stay
 * put while the list moves under them — the reference does the same, and on a
 * ledger long enough to need searching, a search box that scrolls away is a
 * search box you have to scroll back for.
 *
 * It also has to be there rather than in the scroll body for a mechanical
 * reason: the summary card straddles the bar by a negative margin, and Android
 * clips a `ScrollView`'s children to its bounds. Inside the list it would be
 * drawn with its top 26 points cut off.
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
 * Its comment read: "the reference draws the merchant's own logo here, which we
 * have no licence to and no asset for." The assets arrived on 2026-09-05, so
 * the row draws the mark the reference draws. The table it replaced also gave
 * **eSewa and Khalti the same glyph**, which defeated the point it was making —
 * an owner scanning for "the eSewa ones" was reading a column of identical
 * pictures.
 *
 * `<WalletMark>` keeps the tinted glyph tile for bank and cash, so the column
 * still says which way the money went.
 */

/**
 * A chip that is a **choice**, not a fact.
 *
 * Deliberately not `<Chip>` from `ui/layout`, whose own doc calls it "a small
 * bordered pill: a fact, or a tap target for one" — a phone number, a reference
 * code. Selection is a different job and it needs a different filled state: the
 * reference fills the chosen chip solidly with the accent, and `<Chip>`'s
 * `tone="brand"` is a soft tint that reads as emphasis rather than as "this one
 * is on".
 *
 * Used by both chip groups on this screen — the quick ranges in the header and
 * every group in the filter sheet — so there is one selected-chip appearance
 * rather than two.
 */
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
      onPress={() => {
        onPress();
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

/** The small-caps label over a figure — the reference's `BALANCE`. */
/**
 * The way back to the whole statement, one tap from wherever a filter was set.
 *
 * Deliberately not a `<Button>`: it sits inside a row of chips and a caption
 * line, and a filled or outlined button at that scale would read as the primary
 * thing to do on a screen whose primary thing is the list underneath. It is the
 * same weight as the search field's own clear glyph, which is the control it is
 * a sibling of.
 */
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
      <Ionicons color={colors.mutedForeground} name="close-circle" size={14} />
      <Text className="text-xs font-semibold text-muted-foreground">Clear</Text>
    </Pressable>
  );
}

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
 * One credit.
 *
 * Anatomy straight from the reference: a tinted glyph tile, the title over its
 * clock time, the signed amount hard right, and a footer carrying the running
 * total against a single action pill. The pill is the reference's `REDO` slot —
 * the one per-row shortcut worth a tap — and for a hostel that is the person who
 * paid, not a payment to repeat.
 */
function CreditRow({
  calendar,
  credit,
  mixed,
  onOpen,
  onResident,
}: {
  /*
   * Passed down rather than read from `useDates()` here: this row renders once
   * per credit, and the title has to be spelled in the same calendar as the
   * screen's own headings — taking it as a prop is what makes that impossible
   * to get wrong when the row is reused somewhere else.
   */
  calendar: CalendarSystem;
  credit: StatementCredit;
  /** The list holds debits too, so the running figure is a balance. */
  mixed: boolean;
  onOpen: () => void;
  /** The footer pill: the resident on a credit, the expenses screen on a debit. */
  onResident: () => void;
}) {
  const { colors } = useAppTheme();
  const debit = Boolean(credit.debit);

  return (
    <Pressable
      accessibilityLabel={`${creditTitle(credit, calendar)}, ${debit ? "spent" : "received"} ${formatMoney(credit.amount)}`}
      accessibilityRole="button"
      className="active:opacity-80"
      onPress={onOpen}
    >
      <Card className="gap-3">
        <View className="flex-row items-start gap-3">
          {/* See the resident statement's note: eSewa and Khalti drew the
              same glyph until the real marks arrived. */}
          <WalletMark name={credit.method} size={40} square tone={debit ? "danger" : "success"} />

          <View className="flex-1 gap-1">
            <Text numberOfLines={2} variant="label">
              {creditTitle(credit, calendar)}
            </Text>
            <View className="flex-row flex-wrap items-center gap-2">
              <Text variant="caption">{formatTime(credit.receivedAt)}</Text>
              {credit.expense ? (
                <Badge label={credit.expense.categoryLabel} tone="neutral" />
              ) : null}
              {isPartial(credit) ? <Badge label="Part payment" tone="warning" /> : null}
              {credit.branch ? <Badge label={credit.branch.name} tone="neutral" /> : null}
            </View>
          </View>

          {/*
            The direction marker — what makes a row legible as money in or out
            at a glance without reading the label, the same job the triangle
            does in the reference.
          */}
          <View className="flex-row items-center gap-1 pt-0.5">
            {/* Cash handed to a warden moves money, it does not spend it. */}
            <Ionicons
              color={credit.transfer ? colors.mutedForeground : debit ? colors.destructive : colors.success}
              name={credit.transfer ? "swap-horizontal" : debit ? "caret-down" : "caret-up"}
              size={12}
            />
            <Money tone={credit.transfer ? "default" : debit ? "debit" : "credit"} value={credit.amount} />
          </View>
        </View>

        <View className="flex-row items-end justify-between gap-3 border-t border-border pt-3">
          <View className="shrink gap-0.5">
            <MicroLabel>{mixed ? "Balance" : "Total received"}</MicroLabel>
            {credit.runningTotal === null ? (
              /*
                The ledger was truncated, so every cumulative figure over it is
                short by an unknown amount. A dash and the notice at the top of
                the list, rather than a number nobody can reconcile against their
                own cash book.
              */
              <Text variant="label">—</Text>
            ) : (
              <Money value={credit.runningTotal} />
            )}
          </View>

          <Pressable
            accessibilityLabel={debit ? "Open expenses" : `Open ${credit.residentName || "this resident"}`}
            accessibilityRole="button"
            className="rounded-lg bg-brand-soft px-3 py-2 active:opacity-70"
            hitSlop={6}
            onPress={onResident}
          >
            <Text className="text-xs font-bold uppercase tracking-wide text-primary">
              {debit ? "Expenses" : "Resident"}
            </Text>
          </Pressable>
        </View>
      </Card>
    </Pressable>
  );
}

/** The resident, or the expenses screen — in the row's own branch when Overall merged it in. */
function openBehind(credit: StatementCredit) {
  const route = credit.debit ? "/expenses" : `/manage/resident/${credit.residentId}`;

  if (credit.branch) openInBranch(credit.branch, route);
  else router.push(route as never);
}

export default function ManageStatementScreen() {
  const dates = useDates();
  const { colors } = useAppTheme();
  // Overall: the same statement over every branch at once, each row tagged (`getOverallLedger`).
  const overall = useIsOverall();

  const ledgerQuery = adminQuery.ledger();
  const ledger = useResource<AdminLedger>(ledgerQuery.load, {
    cacheKey: ledgerQuery.key,
    topics: ledgerQuery.topics,
  });

  /*
   * Tolerant, and only for the shared text's first line. A warden may be scoped
   * to several hostels, in which case this read has no `hostelId` it can choose
   * and 404s — `statementShareText` drops the name rather than the screen
   * dropping the button. Same trade admin Home takes for its header.
   */
  const hostelQuery = adminQuery.hostel();
  const hostel = useResource<AdminHostel | null>(hostelQuery.load, {
    cacheKey: hostelQuery.key,
    topics: hostelQuery.topics,
  });

  /**
   * What the list is actually filtered by.
   *
   * Opens on **everything**, and the month chips in the sheet are how a reader
   * narrows it. A statement that opened pre-filtered would hide rows behind a
   * choice nobody made — the screen is opened to see what has come in, and the
   * first thing it shows should be the answer to that.
   */
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
  /*
   * Collapsed to start with.
   *
   * It opened expanded, which meant every visit to the statement began with a
   * row of three range chips nobody had asked for, pushing the first payment
   * further down a screen opened to read payments. A filter is something you go
   * looking for; the pill on the hairline is where it is found, and it carries
   * the count so a filter left on from last time still announces itself with the
   * strip shut.
   */
  const [rangesOpen, setRangesOpen] = useState(false);
  const [open, setOpen] = useState<StatementCredit | null>(null);
  const [exporting, setExporting] = useState(false);
  const [formatOpen, setFormatOpen] = useState(false);

  const credits = useMemo(() => statementCredits(ledger.data), [ledger.data]);
  const visible = useMemo(() => filterCredits(credits, filter), [credits, filter]);
  const days = useMemo(() => groupByDay(visible), [visible]);
  const summary = useMemo(
    () => statementSummary(credits, dates.calendar, new Date(), filter),
    [credits, dates.calendar, filter],
  );
  const methods = useMemo(() => methodOptions(credits), [credits]);
  const statuses = useMemo(() => statusOptions(credits), [credits]);
  const directions = useMemo(() => directionOptions(credits), [credits]);
  /** Whether the owner's expenses are on the list — debits beside credits. */
  const mixed = ledger.data?.expenses != null;
  /**
   * The months the sheet offers, and which of them the draft currently is.
   *
   * `months` comes off the whole ledger, not off `visible`: a picker built from
   * what the live filter left behind would offer only the month already
   * selected, which is the one month nobody needs to pick.
   */
  const months = useMemo(() => monthOptions(credits), [credits]);
  const draftMonths = useMemo(() => activeMonthRange(draft), [draft]);

  const filterCount = activeFilterCount(filter);
  const activeRange = activeQuickRange(filter);
  const truncated = ledger.data?.truncated ?? false;
  /** Whether there is a real statement behind the header's share button. */
  const shareable = !ledger.loading && !ledger.error && ledger.data !== null;

  const share = useCallback(async () => {
    try {
      await Share.share({
        message: statementShareText({
          calendar: dates.calendar,
          credits: visible,
          filter,
          hostelName: overall ? "All branches" : (hostel.data?.name ?? ""),
        }),
      });
    } catch (error) {
      toastError("Could not share", readApiError(error, "The share sheet did not open."));
    }
  }, [dates.calendar, filter, hostel.data, overall, visible]);

  /**
   * Downloads the statement in the format the owner picked.
   *
   * The portal's own collection export, not a file built here from `visible`. A
   * document that says "statement" has to reconcile against the books, and the
   * server's export is the one the web hands an accountant — a second,
   * client-side rendering of the same figures is a second thing to keep right,
   * and the first one to be wrong.
   *
   * `downloadToDevice` rather than a share sheet, and no spinner of its own:
   * progress goes to the global toaster and the notification shade. `exporting`
   * exists only to stop a second tap.
   */
  const exportAs = useCallback(async (format: "csv" | "pdf") => {
    setExporting(true);

    try {
      await downloadToDevice({
        extension: format,
        fileName: "hostel-statement",
        label: "Statement export",
        mimeType: format === "pdf" ? "application/pdf" : "text/csv",
        // Overall has one document for every branch: the owner's all-branches statement PDF.
        url: overall
          ? `${API_BASE_URL}${overallPdfPath("statement", nepalPeriodKey())}`
          : `${API_BASE_URL}/api/v1/hostel-admin/reports/export?format=${format}&report=payments`,
      });
    } catch (error) {
      toastError("Could not export", readApiError(error, "The export did not download."));
    } finally {
      setExporting(false);
    }
  }, [overall]);

  const clearFilters = useCallback(() => {
    setFilter(NO_FILTER);
  }, []);

  const openFilters = useCallback(() => {
    setDraft(filter);
    setFilterOpen(true);
  }, [filter]);

  const setRange = useCallback(
    (days: number) => {
      // Tapping the live chip clears it, so the control can undo itself without
      // a fourth "All" chip that would only ever mean "not the other three".
      setFilter((current) =>
        activeQuickRange(current) === days
          ? { ...current, from: "", to: "" }
          : { ...current, ...quickRange(days) },
      );
    },
    [],
  );

  /* ---------------------------------------------------------------- header */

  const header = (
    <View className="bg-background">
      <AppBar
        accent
        actions={
          <View className="flex-row items-center gap-1">
            {/*
              Off until there is a statement to describe. `statementShareText`
              over an empty list is a well-formed "0 payments · NPR 0 received",
              and sending that from a screen that is still loading — or that
              failed to load at all — puts a figure in somebody's WhatsApp thread
              that is not a fact about the hostel.
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
              <Ionicons color={colors.primaryForeground} name="share-social-outline" size={20} />
            </Pressable>

            <Pressable
              accessibilityLabel="Export this statement"
              accessibilityRole="button"
              className={`h-10 w-10 items-center justify-center rounded-full active:opacity-70 ${
                exporting ? "opacity-50" : ""
              }`}
              disabled={exporting}
              hitSlop={4}
              onPress={() => setFormatOpen(true)}
            >
              <Ionicons color={colors.primaryForeground} name="document-text-outline" size={20} />
            </Pressable>
          </View>
        }
        showBack
        /*
          The bar reserves exactly the room the card below takes back, so the
          card lands where the bar would otherwise have ended and the title row
          stays clear above it. Measured on a device: without this the card sat
          on the back arrow, the title and both actions.
        */
        straddle={STRADDLE}
        subtitle={overall ? "All branches" : mixed ? "Money in and out" : "Money received"}
        title="Statement"
      />

      {/*
        The straddle — NOTES §1. It rides up onto the bar's rounded bottom
        rather than sitting under it, which is what turns two stacked strips
        into one header with an object on its edge. The shadow is what sells
        it; without one the card reads as a hole cut in the paint.
      */}
      <View className="px-5" style={{ marginTop: -STRADDLE }}>
        <Pressable
          accessibilityHint="Opens the money overview"
          accessibilityLabel={
            mixed
              ? `${formatMoney(summary.total)} received and ${formatMoney(summary.out)} spent in ${summary.periodLabel}`
              : `${formatMoney(summary.total)} received in ${summary.periodLabel}`
          }
          accessibilityRole="button"
          className="flex-row items-center gap-3 rounded-2xl border border-border bg-card p-3 active:opacity-80"
          onPress={() => router.push("/(admin)/money")}
          style={{
            elevation: 8,
            shadowColor: "#000000",
            shadowOffset: { height: 6, width: 0 },
            shadowOpacity: 0.13,
            shadowRadius: 16,
          }}
        >
          <View className="h-10 w-10 items-center justify-center rounded-2xl bg-brand-soft">
            <Ionicons color={colors.primary} name="stats-chart-outline" size={18} />
          </View>

          {/*
            A skeleton until the ledger lands, not the zeroed figure.

            `statementSummary([])` is a perfectly well-formed "NPR 0 received in
            August" — and on a slow connection an owner reads that as their
            hostel having taken nothing this month, which is a lie the screen
            tells for as long as the request runs. The whole reason this app
            loads into skeletons is that a placeholder cannot be misread as data.
          */}
          <View className="flex-1 gap-1">
            {ledger.loading ? (
              <>
                <Skeleton height={14} width="72%" />
                <Skeleton height={10} width="45%" />
              </>
            ) : (
              <>
                {mixed ? (
                  <>
                    <Text numberOfLines={1} variant="label">
                      {`${formatMoney(summary.total)} in · ${formatMoney(summary.out)} out`}
                    </Text>
                    <Text numberOfLines={1} variant="caption">
                      {`${summary.periodLabel} · Net ${formatMoney(summary.total - summary.out)}`}
                    </Text>
                  </>
                ) : (
                  <>
                    <Text numberOfLines={1} variant="label">
                      {`${formatMoney(summary.total)} received in ${summary.periodLabel}`}
                    </Text>
                    <Text numberOfLines={1} variant="caption">
                      {summary.count === 1
                        ? "1 payment · Money overview"
                        : `${summary.count} payments · Money overview`}
                    </Text>
                  </>
                )}
              </>
            )}
          </View>

          <Ionicons color={colors.mutedForeground} name="chevron-forward" size={18} />
        </Pressable>
      </View>

      <View className="gap-3 px-5 pb-3 pt-4">
        <View className="flex-row items-center gap-2">
          <View
            className="flex-1 flex-row items-center gap-2 rounded-2xl border border-border bg-card"
            style={{ height: FIELD_HEIGHT, paddingLeft: 14, paddingRight: 12 }}
          >
            {/*
              A bare `TextInput`, not `<Input>`: that one carries a label, its
              own border and its own height, all of which fight a field that is
              meant to read as part of the header. Same call `<AdminSearchBar>`
              makes for the same reason.
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
                <Ionicons color={colors.mutedForeground} name="close-circle" size={16} />
              </Pressable>
            ) : (
              <Ionicons color={colors.mutedForeground} name="search" size={16} />
            )}
          </View>

          {/* The reference's hairline between the field and the filter glyph. */}
          <View className="h-6 w-px bg-border" />

          <Pressable
            accessibilityLabel={
              filterCount === 0 ? "Filter the statement" : `Filter the statement, ${filterCount} on`
            }
            accessibilityRole="button"
            className="h-10 w-10 items-center justify-center rounded-full active:opacity-70"
            hitSlop={6}
            onPress={openFilters}
          >
            <Ionicons color={colors.foreground} name="options-outline" size={21} />

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

            {filterCount > 0 ? <ClearFilters count={filterCount} onPress={clearFilters} /> : null}
          </View>
        ) : filterCount > 0 ? (
          /*
            The strip is shut and something is still filtering the list.

            This is the case the collapse created. A filter set from the sheet —
            or a range left on from the last visit — would otherwise be
            announced only by the small badge on the filter glyph, and undoing it
            would mean opening the sheet to reach its `RESET`. One line, and the
            way out is on it.
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
          onPress={() => {
            setRangesOpen((value) => !value);
          }}
          style={{ height: PILL, width: PILL }}
        >
          <Ionicons
            color={colors.primaryForeground}
            name={rangesOpen ? "chevron-up" : "chevron-down"}
            size={16}
          />
        </Pressable>
      </View>
    </View>
  );

  /* ------------------------------------------------------------------ body */

  if (ledger.error) {
    return (
      <Screen header={header}>
        {/*
          The server's own wording, which for a warden without `viewPayments` is
          a sentence about the permission rather than a network error. Rendering
          it as an empty statement would tell an owner their hostel has taken
          nothing, which is the lie `PermissionCard` exists to stop.
        */}
        <ErrorState message={ledger.error} onRetry={ledger.reload} />
      </Screen>
    );
  }

  return (
    <>
      <Screen
        header={header}
        onRefresh={ledger.refresh}
        padded={false}
        refreshing={ledger.refreshing}
        scroll
      >
        <View className="gap-5 px-5 pt-4">
          {ledger.loading ? <SkeletonRows rows={6} /> : null}

          {!ledger.loading && truncated ? (
            <View className="gap-1 rounded-xl border border-warning/40 bg-warning-soft p-3">
              <Text variant="label">Only the most recent 5,000 invoices</Text>
              <Text variant="caption">
                Older rows were left out, so the running total on each row is hidden rather than
                shown short. The export has the full history.
              </Text>
            </View>
          ) : null}

          {!ledger.loading && filterCount > 0 && visible.length > 0 ? (
            <Text variant="muted">
              {mixed
                ? (() => {
                    const totals = splitTotals(visible);

                    return `${formatMoney(totals.in)} in · ${formatMoney(totals.out)} out · Net ${formatMoney(
                      totals.in - totals.out,
                    )} · ${rangeLabel(filter, dates.calendar)}`;
                  })()
                : `${visible.length === 1 ? "1 payment" : `${visible.length} payments`} · ${formatMoney(
                    visibleTotal(visible),
                  )} · ${rangeLabel(filter, dates.calendar)}`}
            </Text>
          ) : null}

          {!ledger.loading && visible.length === 0 ? (
            filterCount > 0 ? (
              <EmptyCard
                action={<Button label="Clear filters" onPress={() => setFilter(NO_FILTER)} size="sm" variant="outline" />}
                description="Nothing in the statement matches what you asked for."
                title={mixed ? "Nothing here" : "No payments here"}
              />
            ) : (
              <EmptyCard
                description={
                  mixed
                    ? "Every payment a resident makes, and every expense you record, lands here."
                    : "Every payment a resident makes lands here the moment it is recorded or verified."
                }
                title={mixed ? "Nothing has moved yet" : "Nothing has come in yet"}
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

              {day.rows.map((credit) => (
                <CreditRow
                  calendar={dates.calendar}
                  credit={credit}
                  key={credit.id}
                  mixed={mixed}
                  onOpen={() => setOpen(credit)}
                  onResident={() => openBehind(credit)}
                />
              ))}
            </View>
          ))}
        </View>
      </Screen>

      {/* --------------------------------------------------------- format */}
      {/*
        Asked, not assumed. The button used to produce a CSV on the way out, and
        the two formats are for different people: a spreadsheet is what an
        accountant reconciles against, a PDF is what a bank, a landlord or a
        family member is handed. Guessing wrong means the owner exports twice
        and opens the wrong one in between.

        A bottom sheet of rows rather than an anchored menu — NOTES §6 — and the
        file is generated only after the choice, so nothing is built and thrown
        away.
      */}
      <Sheet
        bare
        onClose={() => setFormatOpen(false)}
        open={formatOpen}
        title="Export this statement"
      >
        <SheetRow
          label="PDF"
          onPress={() => {
            setFormatOpen(false);
            void exportAs("pdf");
          }}
          subtitle="Laid out to read, print or send on"
          trailing={
            <Ionicons color={colors.mutedForeground} name="document-text-outline" size={20} />
          }
        />
        {overall ? null : <SheetRow
          label="Spreadsheet"
          onPress={() => {
            setFormatOpen(false);
            void exportAs("csv");
          }}
          subtitle="A CSV your accountant can open in Excel"
          trailing={<Ionicons color={colors.mutedForeground} name="grid-outline" size={20} />}
        />}
      </Sheet>

      {/* --------------------------------------------------------- detail */}
      <Sheet
        footer={
          open ? (
            <View className="flex-row gap-3">
              <View className="flex-1">
                <Button
                  label={open.debit ? "Open expenses" : "Open resident"}
                  onPress={() => {
                    const credit = open;

                    setOpen(null);
                    openBehind(credit);
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
        title={open?.debit ? "Expense details" : "Payment details"}
      >
        {open ? (
          <View className="gap-4 pb-2">
            <View className="flex-row items-start gap-3">
              <WalletMark
                name={open.method}
                size={44}
                square
                tone={open.debit ? "danger" : "success"}
              />

              <View className="flex-1 gap-1">
                <Text variant="subtitle">{creditTitle(open, dates.calendar)}</Text>
                <Text variant="caption">{dates.dateTime(open.receivedAt)}</Text>
                {open.branch ? <Text variant="caption">{open.branch.name}</Text> : null}
              </View>
            </View>

            <View className="flex-row items-center justify-between gap-3">
              <Money size="large" tone={open.debit ? "debit" : "credit"} value={open.amount} />
              {open.expense ? (
                <Badge label="Spent" tone="danger" />
              ) : (
                <StatusPill status={open.status} />
              )}
            </View>

            {open.expense ? (
              <View className="gap-0 border-t border-border pt-1">
                <FactRow label="Spent" value={formatMoney(open.amount)} />
                <FactRow label="Spent on" value={dates.date(open.receivedAt)} />
                <FactRow label="Category" value={open.expense.categoryLabel} />
                {open.expense.what.trim() ? (
                  <FactRow label="For" value={open.expense.what.trim()} />
                ) : null}
                {open.expense.salaryFor ? (
                  <FactRow label="Salary for" value={open.expense.salaryFor.name} />
                ) : null}
                <FactRow label="Paid by" value={humanizeEnum(open.method)} />
                <FactRow label="Recorded by" value={open.expense.recordedBy.name || "Staff"} />
                {open.runningTotal === null ? null : (
                  <FactRow label="Balance" value={formatMoney(open.runningTotal)} />
                )}
              </View>
            ) : (
            /*
              A label/value grid, not a table — NOTES §8. The pairs are ordered
              the way somebody checks a payment: what arrived against what was
              asked, then when, then how, then what it was for.
            */
            <View className="gap-0 border-t border-border pt-1">
              <FactRow label="Received" value={formatMoney(open.amount)} />
              <FactRow label="Billed" value={formatMoney(open.billed)} />
              {isPartial(open) ? (
                <FactRow label="Still owed" value={formatMoney(open.billed - open.amount)} />
              ) : null}
              <FactRow label="Received on" value={dates.date(open.receivedAt)} />
              <FactRow label="Method" value={humanizeEnum(open.method)} />
              <FactRow
                label="For"
                value={open.period ? dates.period(open.period) : "A one-off charge"}
              />
              {open.dueDate ? (
                <FactRow label="Was due" value={dates.date(open.dueDate)} />
              ) : null}
              <FactRow label="Resident" value={open.residentName || "Not recorded"} />
              {open.remarks ? <FactRow label="Remarks" value={open.remarks} /> : null}
              {open.runningTotal === null ? null : (
                <FactRow
                  label={mixed ? "Balance" : "Total received"}
                  value={formatMoney(open.runningTotal)}
                />
              )}
              {/*
                The reference's "Transaction Code". Ours is the invoice id — the
                only identifier that exists on both sides of a support call, and
                the thing to quote when a resident says the money left their
                account.
              */}
              <FactRow label="Invoice" value={open.id} />
            </View>
            )}
          </View>
        ) : null}
      </Sheet>

      {/* --------------------------------------------------------- filters */}
      <Sheet
        footer={
          <View className="flex-row items-center gap-3">
            <View className="flex-1">
              <Button
                label="Reset"
                onPress={() => setDraft(NO_FILTER)}
                variant="ghost"
              />
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
            Both groups are built from the ledger rather than from the enum. A
            hostel that only ever takes cash would otherwise get five chips that
            filter to nothing, and a control whose options are mostly dead
            teaches people not to open it. See `methodOptions`.
          */}
          {directions.length > 0 ? (
            <ChipGroup
              onChange={(direction) => setDraft((current) => ({ ...current, direction }))}
              options={directions}
              title="Money"
              value={draft.direction}
            />
          ) : null}

          <ChipGroup
            onChange={(status) => setDraft((current) => ({ ...current, status }))}
            options={statuses}
            title="Status"
            value={draft.status}
          />

          <ChipGroup
            onChange={(method) => setDraft((current) => ({ ...current, method }))}
            options={methods}
            title="How it arrived"
            value={draft.method}
          />

          <View className="gap-2">
            <Text variant="label">Date</Text>

            {/*
              Months first, because a month is what a hostel's books are kept in
              and it is the answer to almost every question this sheet is opened
              with. The chips are the hostel's own collection months — see
              `monthOptions` — and they write into the same `from`/`to` the typed
              fields and the quick ranges below edit, so the three controls can
              never disagree about what is on screen. `activeMonthRange` reads
              the selection back out of those two strings rather than remembering
              it, which is what lets a typed date that lands mid-month
              un-highlight the chip on its own.

              `dates.period` rather than a formatter from `lib/format.ts`: the
              chips are dates being *read*, so they follow the portal's calendar
              like everything else under `app/`. See `use-dates.ts`.
            */}
            <View className="flex-row flex-wrap gap-2">
              {months.map((period) => (
                <FilterChip
                  key={period}
                  label={dates.period(period)}
                  onPress={() =>
                    setDraft((current) => ({ ...current, ...monthRange(period) }))
                  }
                  selected={draftMonths?.from === period && draftMonths.to === period}
                />
              ))}
            </View>

            {/*
              The second end of a run of months, and only once there is a first
              end to run from. Offered as its own row rather than as a "tap two
              chips" gesture on the row above: a selection that changes meaning
              on the second tap is not discoverable, and this way each row says
              what it does. Reaching back past the start widens the range from
              the other end instead of refusing it — see `monthRange`.
            */}
            {draftMonths ? (
              <View className="gap-2">
                <Text variant="caption">Up to</Text>
                <View className="flex-row flex-wrap gap-2">
                  {months.map((period) => (
                    <FilterChip
                      key={period}
                      label={dates.period(period)}
                      onPress={() =>
                        setDraft((current) => ({
                          ...current,
                          ...monthRange(draftMonths.from, period),
                        }))
                      }
                      selected={draftMonths.to === period}
                    />
                  ))}
                </View>
              </View>
            ) : null}

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
              rules out building a date picker, and `lib/manage-dates.ts` already
              made this call for every other date in the admin group: three taps
              and a modal for something a person can type in.
            */}
            <View className="flex-row flex-wrap gap-2">
              {QUICK_RANGES.map((days) => (
                <FilterChip
                  key={days}
                  label={`${days} days`}
                  onPress={() =>
                    setDraft((current) => ({ ...current, ...quickRange(days) }))
                  }
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
            label="At least (NPR)"
            onChangeText={(minAmount) => setDraft((current) => ({ ...current, minAmount }))}
            placeholder="e.g. 5000"
            value={draft.minAmount}
          />
        </View>
      </Sheet>
    </>
  );
}
