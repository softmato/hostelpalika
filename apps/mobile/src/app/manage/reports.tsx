import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { Download } from "lucide-react-native";
import { type ReactNode, useCallback, useMemo, useState } from "react";

import { addBsMonths } from "@hostel/calendar/bs";
import { Pressable, View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { DataCard } from "@/components/ui/data-card";
import { Chip, FactRow, Grid, InfoTile, StatTile } from "@/components/ui/layout";
import { Meter } from "@/components/ui/meter";
import { Money } from "@/components/ui/money";
import { Screen } from "@/components/ui/screen";
import { Sheet, SheetRow } from "@/components/ui/sheet";
import { Skeleton, SkeletonCard, SkeletonTiles } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import {
  type MonthCompare,
  type PerformanceReport,
  REPORT_EXPORTS,
  type ReportExport,
  performanceReportPdfPath,
  statementPdfPath,
} from "@/lib/admin-manage-api";
import type { AdminLedger } from "@/lib/admin-api";
import { type AdminReportsData, adminQuery } from "@/lib/admin-queries";
import { API_BASE_URL } from "@/lib/api";
import { readApiError } from "@/lib/api-contract";
import { downloadToDevice } from "@/lib/documents";
import { formatMoney, humanizeEnum } from "@/lib/format";
import { monthlyTotals, splitTotals, statementCredits } from "@/lib/hostel-statement";
import { toastError } from "@/lib/toast";

/**
 * Reports — the hostel's month, and the PDF of it.
 *
 * ## What changed, and why
 *
 * This screen used to be the portal's Reports page squeezed onto a phone: four
 * headline tiles, an export row, three tabs, and under them every breakdown the
 * overview endpoint returns — payment statuses, complaint categories, referral
 * rewards, zone chips — as chips and meters. All true, and an owner opening it
 * could not tell what mattered. It now answers four questions, in order: how
 * much rent came in, who lives here and who is in tonight, how many people saw
 * the listing, and what is still open. Everything else is one tile away.
 *
 * ## The screen and the PDF are one payload
 *
 * Both read `reports/performance` for the chosen BS month. Download fetches
 * the same figures as a two-page PDF, so what the owner sends on is what they
 * were looking at when they pressed the button.
 *
 * ## A month, or right now
 *
 * Rent, move-ins, page views and complaints raised are counted inside the
 * month. Who lives here, who is in tonight and how many beds are free have no
 * history, so they are always *now* — the section says so rather than letting
 * an earlier month's report imply otherwise.
 *
 * ## Attendance can say when, never where
 *
 * The night check-ins sheet is built from zone rows. Coordinates are discarded
 * as each ping lands and a test enforces it.
 */

/** How far the month card rides up onto the painted bar. */
const STRADDLE = 26;

const LIFT = {
  elevation: 8,
  shadowColor: "#000000",
  shadowOffset: { height: 6, width: 0 },
  shadowOpacity: 0.13,
  shadowRadius: 16,
} as const;

type SheetName = "exports" | "food" | "month" | "night" | "pdf" | null;

/** How many months the month-by-month list shows before "Show all". */
const MONTHS_SHOWN = 6;

function rateTone(rate: number | null): "danger" | "neutral" | "success" | "warning" {
  if (rate === null) {
    return "neutral";
  }

  if (rate >= 85) {
    return "success";
  }

  return rate >= 60 ? "warning" : "danger";
}

/** `1 bed`, `4 beds`. */
function plural(value: number, noun: string) {
  return `${value.toLocaleString("en-IN")} ${noun}${value === 1 ? "" : "s"}`;
}

function percent(rate: number | null) {
  return rate === null ? "—" : `${Math.round(rate)}%`;
}

/** `+20% vs Shrawan` — the line under a listing figure. */
function changeLine({ current, previous }: MonthCompare, previousName: string) {
  if (previous === 0) {
    return current === 0 ? `None in ${previousName} either` : `None in ${previousName}`;
  }

  const delta = Math.round(((current - previous) / previous) * 100);

  return delta === 0
    ? `Same as ${previousName}`
    : `${delta > 0 ? "+" : ""}${delta}% vs ${previousName}`;
}

/** `1110` → `18:30`. The analytics service reports minutes since midnight. */
function clockTime(minutes: number | null) {
  if (minutes === null) {
    return "—";
  }

  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function delayLabel(minutes: number | null) {
  if (minutes === null) {
    return "No timing set";
  }

  if (minutes === 0) {
    return "On time";
  }

  return minutes > 0 ? `${minutes} min late` : `${Math.abs(minutes)} min early`;
}

/* -------------------------------------------------------------------------- */
/* Header                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The month this report is about, and the button that downloads it.
 *
 * On the bar's edge because it is what everything under it depends on: change
 * the month and every figure below changes with it, and the PDF is of this
 * month. Putting Download beside the month rather than at the foot of a long
 * scroll is so the answer to "can I get this as a file" is visible on arrival.
 */
function MonthCard({
  caption,
  downloading,
  label,
  onDownload,
  onPick,
}: {
  caption: string;
  downloading: boolean;
  /** `null` while the report has not arrived — the card draws skeletons. */
  label: string | null;
  onDownload: () => void;
  onPick: () => void;
}) {
  const { colors } = useAppTheme();

  return (
    <View className="px-5" style={{ marginTop: -STRADDLE }}>
      <View
        className="flex-row items-center gap-3 rounded-2xl border border-border bg-card p-3"
        style={LIFT}
      >
        <Pressable
          accessibilityHint="Choose another month"
          accessibilityLabel={label ? `Report for ${label}` : "Report month"}
          accessibilityRole="button"
          className="flex-1 flex-row items-center gap-3 active:opacity-70"
          disabled={label === null}
          onPress={onPick}
        >
          <View className="h-10 w-10 items-center justify-center rounded-2xl bg-brand-soft">
            <Ionicons color={colors.primary} name="calendar-outline" size={18} />
          </View>

          {label === null ? (
            <View className="flex-1 gap-1.5">
              <Skeleton height={14} width="60%" />
              <Skeleton height={10} width="40%" />
            </View>
          ) : (
            <View className="flex-1">
              <View className="flex-row items-center gap-1">
                <Text className="shrink" numberOfLines={1} variant="subtitle">
                  {label}
                </Text>
                <Ionicons color={colors.mutedForeground} name="chevron-down" size={14} />
              </View>
              <Text numberOfLines={1} variant="caption">
                {caption}
              </Text>
            </View>
          )}
        </Pressable>

        <Button
          disabled={label === null}
          icon={Download}
          label="PDF"
          loading={downloading}
          onPress={onDownload}
          size="sm"
        />
      </View>
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Rent                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Billed against collected, six months, the selected one last.
 *
 * Six equal columns rather than a scroller: six months always fit a phone, and
 * a strip that scrolls sideways hides the month the owner picked off the edge.
 * Plain `View`s with percentage heights — twelve bars is layout, not charting.
 */
function TrendBars({ trend }: { trend: PerformanceReport["finance"]["trend"] }) {
  const dates = useDates();
  const peak = Math.max(0, ...trend.map((point) => Math.max(point.billed, point.collected)));

  if (peak === 0) {
    return <Text variant="muted">Nothing was billed in these six months.</Text>;
  }

  return (
    <View className="gap-3">
      <View className="flex-row">
        {trend.map((point, index) => {
          const selected = index === trend.length - 1;

          return (
            <View
              accessibilityLabel={`${dates.period(point.month)}: ${formatMoney(point.collected)} of ${formatMoney(point.billed)}`}
              className="flex-1 items-center gap-1.5"
              key={point.month}
            >
              <View className="h-24 flex-row items-end gap-1">
                <View
                  className="w-2.5 rounded-t bg-muted"
                  style={{ height: `${Math.max(2, (point.billed / peak) * 100)}%` }}
                />
                <View
                  className={`w-2.5 rounded-t ${selected ? "bg-primary" : "bg-primary/50"}`}
                  style={{
                    height: `${Math.max(2, (Math.min(point.collected, peak) / peak) * 100)}%`,
                  }}
                />
              </View>
              <Text
                className={`text-[10px] ${selected ? "font-semibold text-foreground" : "text-muted-foreground"}`}
                numberOfLines={1}
                variant={null}
              >
                {dates.periodMonth(point.month)}
              </Text>
            </View>
          );
        })}
      </View>

      <View className="flex-row items-center gap-4">
        <View className="flex-row items-center gap-1.5">
          <View className="h-2.5 w-2.5 rounded-sm bg-muted" />
          <Text variant="caption">Billed</Text>
        </View>
        <View className="flex-row items-center gap-1.5">
          <View className="h-2.5 w-2.5 rounded-sm bg-primary" />
          <Text variant="caption">Collected</Text>
        </View>
      </View>
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Month by month                                                             */
/* -------------------------------------------------------------------------- */

/**
 * One month on the month-by-month list: the month on the left, money in and
 * money out under it, the net hard right. Tapping it opens that month's
 * detail below when the report covers it.
 */
function MonthRow({
  label,
  mixed,
  money,
  onPress,
  selected,
}: {
  label: string;
  /** Whether expenses are on the ledger — a warden's has credits only. */
  mixed: boolean;
  money: { in: number; out: number };
  onPress?: () => void;
  selected: boolean;
}) {
  const { colors } = useAppTheme();
  const net = money.in - money.out;

  return (
    <Pressable
      accessibilityLabel={`${label}: ${formatMoney(money.in)} in${mixed ? `, ${formatMoney(money.out)} out` : ""}`}
      accessibilityRole={onPress ? "button" : undefined}
      className="flex-row items-center gap-3 py-3 active:opacity-70"
      disabled={!onPress}
      onPress={onPress}
    >
      <View
        className={`h-9 w-9 items-center justify-center rounded-xl ${selected ? "bg-primary" : "bg-brand-soft"}`}
      >
        <Ionicons
          color={selected ? colors.primaryForeground : colors.primary}
          name="calendar-outline"
          size={16}
        />
      </View>
      <View className="flex-1 gap-0.5">
        <Text numberOfLines={1} variant="label">
          {label}
        </Text>
        <View className="flex-row flex-wrap items-center gap-x-3">
          <Text className="text-xs font-semibold text-success">{`↑ ${formatMoney(money.in)}`}</Text>
          {mixed ? (
            <Text className="text-xs font-semibold text-destructive">{`↓ ${formatMoney(money.out)}`}</Text>
          ) : null}
        </View>
      </View>
      {mixed ? <Money tone={net < 0 ? "debit" : "default"} value={Math.abs(net)} /> : null}
      {onPress ? <Ionicons color={colors.mutedForeground} name="chevron-forward" size={16} /> : null}
    </Pressable>
  );
}

/* -------------------------------------------------------------------------- */
/* Loading                                                                    */
/* -------------------------------------------------------------------------- */

function ReportsSkeleton() {
  return (
    <View className="gap-5 pt-2">
      <SkeletonCard rows={3} />
      <SkeletonCard rows={4} />
      <SkeletonTiles columns={3} />
      <SkeletonTiles columns={2} />
    </View>
  );
}

function Section({
  children,
  subtitle,
  title,
}: {
  children: ReactNode;
  subtitle?: string;
  title: string;
}) {
  return (
    <View>
      <SectionHeader subtitle={subtitle} title={title} />
      {children}
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Screen                                                                     */
/* -------------------------------------------------------------------------- */

export default function ManageReportsScreen() {
  const dates = useDates();
  const { colors } = useAppTheme();
  const [month, setMonth] = useState("");
  const [sheet, setSheet] = useState<SheetName>(null);
  const [downloading, setDownloading] = useState(false);
  const [exporting, setExporting] = useState<ReportExport | "">("");

  const query = adminQuery.reports(month);
  const reports = useResource<AdminReportsData>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  /*
    The ledger behind the Overall and month-by-month sections — the same read
    the statement screen uses, so the two agree. Expenses ride along for the
    owner only; a warden without `viewPayments` gets an error here and the
    two sections simply do not draw.
  */
  const ledgerQuery = adminQuery.ledger();
  const ledger = useResource<AdminLedger>(ledgerQuery.load, {
    cacheKey: ledgerQuery.key,
    topics: ledgerQuery.topics,
  });
  const [allMonths, setAllMonths] = useState(false);
  const ledgerRows = useMemo(() => statementCredits(ledger.data), [ledger.data]);
  const overall = useMemo(() => splitTotals(ledgerRows), [ledgerRows]);
  const byMonth = useMemo(() => monthlyTotals(ledgerRows), [ledgerRows]);
  const mixed = ledger.data?.expenses != null;

  const report = reports.data?.report ?? null;
  const attendance = reports.data?.attendance ?? null;
  const foodTiming = reports.data?.food ?? null;

  const downloadPdf = useCallback(async () => {
    if (!report) {
      return;
    }

    setDownloading(true);

    try {
      // A download, not a share — `downloadToDevice` reports into the toaster
      // and the notification shade itself, so this state only stops a second tap.
      await downloadToDevice({
        extension: "pdf",
        fileName: `performance-${report.period.month}`,
        label: `${dates.period(report.period.month)} report`,
        mimeType: "application/pdf",
        url: `${API_BASE_URL}${performanceReportPdfPath(report.period.month)}`,
      });
    } catch (error) {
      toastError("Could not download", readApiError(error, "The report did not download."));
    } finally {
      setDownloading(false);
    }
  }, [dates, report]);

  /** The bank-style statement between two BS months, inclusive. */
  const downloadStatement = useCallback(
    async (from: string, to: string) => {
      setDownloading(true);

      try {
        await downloadToDevice({
          extension: "pdf",
          fileName: from === to ? `statement-${from}` : `statement-${from}-to-${to}`,
          label: from === to ? `${dates.period(from)} statement` : `${dates.period(from)} to ${dates.period(to)} statement`,
          mimeType: "application/pdf",
          url: `${API_BASE_URL}${statementPdfPath(from, to)}`,
        });
      } catch (error) {
        toastError("Could not download", readApiError(error, "The statement did not download."));
      } finally {
        setDownloading(false);
      }
    },
    [dates],
  );

  const exportCsv = useCallback(async (entry: ReportExport) => {
    setExporting(entry);

    try {
      await downloadToDevice({
        extension: "csv",
        fileName: `${entry}-report`,
        label: `${humanizeEnum(entry)} spreadsheet`,
        mimeType: "text/csv",
        url: `${API_BASE_URL}/api/v1/hostel-admin/reports/export?report=${entry}`,
      });
    } catch (error) {
      toastError("Could not export", readApiError(error, "The export did not download."));
    } finally {
      setExporting("");
    }
  }, []);

  const header = (
    <View className="bg-background">
      <AppBar accent centerTitle showBack straddle={STRADDLE} title="Reports" />
      <MonthCard
        caption={report?.period.isCurrent ? "This month so far" : "Whole month"}
        downloading={downloading}
        label={report ? dates.period(report.period.month) : null}
        onDownload={() => setSheet("pdf")}
        onPick={() => setSheet("month")}
      />
    </View>
  );

  if (reports.loading) {
    return (
      <Screen header={header} scroll>
        <ReportsSkeleton />
      </Screen>
    );
  }

  if (reports.error || !report) {
    return (
      <Screen header={header}>
        <ErrorState
          message={reports.error ?? "Reports could not be loaded."}
          onRetry={reports.reload}
        />
      </Screen>
    );
  }

  const { beds, finance, listing, operations, residents } = report;
  const monthName = dates.periodMonth(report.period.month);
  const previousName = dates.periodMonth(report.period.previousMonth);
  const { now, tonight } = residents;

  const detailTiles = [
    <InfoTile
      badge={operations.complaints.open}
      caption={
        operations.complaints.pastSla > 0
          ? `${operations.complaints.pastSla} past due`
          : `${operations.complaints.raised} raised in ${monthName}`
      }
      icon="chatbox-ellipses-outline"
      key="complaints"
      label="Complaints"
      onPress={() => router.push("/manage/complaints")}
      tone={operations.complaints.pastSla > 0 ? "danger" : "warning"}
    />,
    <InfoTile
      badge={operations.repairs.open}
      caption={`${operations.repairs.completed} done in ${monthName}`}
      icon="construct-outline"
      key="repairs"
      label="Repairs"
      onPress={() => router.push("/manage/maintenance")}
      tone="neutral"
    />,
    attendance ? (
      <InfoTile
        caption="Last 30 days"
        icon="moon-outline"
        key="night"
        label="Night check-ins"
        onPress={() => setSheet("night")}
      />
    ) : null,
    foodTiming ? (
      <InfoTile
        caption="Last 30 days"
        icon="restaurant-outline"
        key="food"
        label="Meal timing"
        onPress={() => setSheet("food")}
        tone="success"
      />
    ) : null,
    <InfoTile
      caption="CSV"
      icon="grid-outline"
      key="exports"
      label="Spreadsheets"
      onPress={() => setSheet("exports")}
      tone="neutral"
    />,
  ].filter((tile): tile is NonNullable<typeof tile> => tile !== null);

  return (
    <Screen
      header={header}
      onRefresh={() => {
        reports.refresh();
        ledger.refresh();
      }}
      refreshing={reports.refreshing}
      scroll
    >
      <View className="gap-6 pt-2">
        {/* --------------------------------------------------------- overall */}
        {ledger.loading ? (
          <SkeletonCard rows={3} />
        ) : ledger.data ? (
          <Section subtitle="Everything recorded so far" title="Overall">
            <DataCard
              footer={{
                left: `${plural(overall.inCount, "payment")}${mixed ? ` · ${plural(overall.outCount, "expense")}` : ""}`,
                pill: mixed ? `Net ${formatMoney(overall.in - overall.out)}` : undefined,
                right: finance.outstandingAllTime > 0 ? `${formatMoney(finance.outstandingAllTime)} still owed` : "",
              }}
              meta={mixed ? "Money in and out" : "Money received"}
              onPress={() => router.push("/manage/finance/statement")}
              segments={
                mixed
                  ? [
                      { label: "Money in", tone: "brand", value: overall.in },
                      { label: "Money out", tone: "danger", value: overall.out },
                    ]
                  : undefined
              }
              stats={
                mixed
                  ? [
                      { label: "Money in", value: formatMoney(overall.in) },
                      { label: "Money out", value: formatMoney(overall.out) },
                      { label: "Net", value: formatMoney(overall.in - overall.out) },
                    ]
                  : [
                      { label: "Received", value: formatMoney(overall.in) },
                      { label: "Still owed", value: formatMoney(finance.outstandingAllTime) },
                    ]
              }
              title="All time"
              total={mixed ? overall.in + overall.out : undefined}
            />
          </Section>
        ) : null}

        {/* --------------------------------------------------- month by month */}
        {ledger.data && byMonth.length > 0 ? (
          <Section subtitle="Tap a month to see it in detail below" title="Month by month">
            <Card className="py-1">
              {(allMonths ? byMonth : byMonth.slice(0, MONTHS_SHOWN)).map((entry, index) => {
                const reportIndex = report.period.months.indexOf(entry.month);

                return (
                  <View className={index > 0 ? "border-t border-border" : undefined} key={entry.month}>
                    <MonthRow
                      label={dates.period(entry.month)}
                      mixed={mixed}
                      money={entry}
                      onPress={
                        reportIndex < 0
                          ? undefined
                          : () => setMonth(reportIndex === 0 ? "" : entry.month)
                      }
                      selected={entry.month === report.period.month}
                    />
                  </View>
                );
              })}
              {byMonth.length > MONTHS_SHOWN ? (
                <Pressable
                  accessibilityRole="button"
                  className="items-center border-t border-border py-3 active:opacity-70"
                  onPress={() => setAllMonths((current) => !current)}
                >
                  <Text className="text-xs font-bold uppercase tracking-wide text-primary">
                    {allMonths ? "Show fewer" : `Show all ${byMonth.length} months`}
                  </Text>
                </Pressable>
              ) : null}
            </Card>
          </Section>
        ) : null}

        {/* ------------------------------------------------------------ rent */}
        <Section subtitle={dates.period(report.period.month)} title="Rent">
          <View className="gap-3">
            <DataCard
              footer={{
                left:
                  finance.previous.collectionRate === null
                    ? `${previousName}: nothing billed`
                    : `${previousName}: ${percent(finance.previous.collectionRate)}`,
                pill:
                  finance.collectionRate === null
                    ? "Nothing billed"
                    : `${percent(finance.collectionRate)} collected`,
                right:
                  finance.pendingProofs > 0 ? `${plural(finance.pendingProofs, "proof")} to check` : "",
              }}
              meta={`Billed for ${monthName}`}
              onPress={() => router.push("/(admin)/money")}
              segments={[{ label: "Collected", tone: "brand", value: finance.collected }]}
              stats={[
                { label: "Billed", value: formatMoney(finance.billed) },
                { label: "Collected", value: formatMoney(finance.collected) },
                { label: "Still owed", value: formatMoney(finance.outstanding) },
              ]}
              title={`Rent for ${monthName}`}
              total={finance.billed}
            />

            <Card className="gap-4">
              <TrendBars trend={finance.trend} />
              <View className="border-t border-border">
                <FactRow
                  label="Owed across all months"
                  value={<Money owed={finance.outstandingAllTime > 0} value={finance.outstandingAllTime} />}
                />
              </View>
            </Card>
          </View>
        </Section>

        {/* ------------------------------------------------------- residents */}
        <Section title="Residents">
          <View className="gap-3">
            <DataCard
              footer={{
                left: `${now.active} active`,
                right: [
                  now.pending > 0 ? `${now.pending} pending` : "",
                  now.suspended > 0 ? `${now.suspended} suspended` : "",
                ]
                  .filter(Boolean)
                  .join(" · "),
              }}
              meta={`${now.total} living here`}
              onPress={() => router.push("/manage/roll-call")}
              segments={[
                { label: `${tonight.inside} inside`, tone: "success", value: tonight.inside },
                { label: `${tonight.outside} outside`, tone: "neutral", value: tonight.outside },
              ]}
              stats={[
                { label: "Inside", value: String(tonight.inside) },
                { label: "Outside", value: String(tonight.outside) },
                { label: "No answer", value: String(tonight.notAnswered) },
              ]}
              title="Tonight"
              total={now.total}
            />

            <View className="flex-row gap-3">
              <StatTile
                icon="log-in-outline"
                label="Moved in"
                tone={residents.movedIn > 0 ? "success" : "neutral"}
                trend={`in ${monthName}`}
                value={String(residents.movedIn)}
              />
              <StatTile
                icon="log-out-outline"
                label="Moved out"
                tone="neutral"
                trend={`in ${monthName}`}
                value={String(residents.movedOut)}
              />
              <StatTile
                icon="bed-outline"
                label="Occupancy"
                onPress={() => router.push("/manage/rooms")}
                tone={rateTone(beds.occupancyRate)}
                trend={`${plural(beds.vacant, "bed")} free`}
                value={percent(beds.occupancyRate)}
              />
            </View>
          </View>
        </Section>

        {/* --------------------------------------------------------- listing */}
        <Section subtitle={`${monthName} against ${previousName}`} title="Public listing">
          <View className="gap-3">
            <View className="flex-row gap-3">
              <StatTile
                icon="search-outline"
                label="Seen in search"
                trend={changeLine(listing.appearances, previousName)}
                value={listing.appearances.current.toLocaleString("en-IN")}
              />
              <StatTile
                icon="eye-outline"
                label="Page views"
                trend={changeLine(listing.views, previousName)}
                value={listing.views.current.toLocaleString("en-IN")}
              />
            </View>
            <View className="flex-row gap-3">
              <StatTile
                icon="people-outline"
                label="Visitors"
                trend={changeLine(listing.visitors, previousName)}
                value={listing.visitors.current.toLocaleString("en-IN")}
              />
              <StatTile
                icon="chatbubbles-outline"
                label="Inquiries"
                onPress={() => router.push("/manage/inquiries")}
                tone="brand"
                trend={`${listing.inquiriesConverted} moved in`}
                value={String(listing.inquiries.current)}
              />
            </View>
            <Card>
              <FactRow
                label="Rating"
                value={
                  listing.rating.average === null
                    ? "No reviews yet"
                    : `★ ${listing.rating.average.toFixed(1)} · ${plural(listing.rating.total, "review")}`
                }
              />
            </Card>
          </View>
        </Section>

        {/* --------------------------------------------------------- details */}
        <Section title="Details">
          <Grid maxColumns={3}>{detailTiles}</Grid>
        </Section>

        <Text className="text-center" variant="caption">
          {`Figures as of ${dates.dateTime(report.generatedAt)}`}
        </Text>
      </View>

      {/* ----------------------------------------------------------- sheets */}
      <Sheet bare onClose={() => setSheet(null)} open={sheet === "month"} title="Report month">
        {report.period.months.map((option, index) => {
          const selected = option === report.period.month;

          return (
            <SheetRow
              key={option}
              label={dates.period(option)}
              onPress={() => {
                setSheet(null);
                // The current month is the default key, so picking it again
                // reuses the cached report instead of fetching it twice.
                setMonth(index === 0 ? "" : option);
              }}
              selected={selected}
              subtitle={index === 0 ? "This month so far" : undefined}
              trailing={
                selected ? <Ionicons color={colors.primary} name="checkmark" size={20} /> : undefined
              }
            />
          );
        })}
      </Sheet>

      <Sheet bare onClose={() => setSheet(null)} open={sheet === "pdf"} title="Download PDF">
        {(() => {
          const selected = report.period.month;
          const yearStart = `${selected.slice(0, 4)}-01`;
          const options = [
            { from: selected, label: `Statement · ${dates.period(selected)}`, to: selected },
            {
              from: addBsMonths(selected, -2),
              label: `Statement · ${dates.period(addBsMonths(selected, -2))} to ${dates.period(selected)}`,
              to: selected,
            },
            {
              from: addBsMonths(selected, -5),
              label: `Statement · last 6 months`,
              to: selected,
            },
            ...(yearStart !== selected
              ? [{ from: yearStart, label: `Statement · ${dates.period(yearStart)} to ${dates.period(selected)}`, to: selected }]
              : []),
          ];

          return (
            <>
              {options.map((option) => (
                <SheetRow
                  key={option.label}
                  label={option.label}
                  onPress={() => {
                    setSheet(null);
                    void downloadStatement(option.from, option.to);
                  }}
                  subtitle={mixed ? "Bank-style · every credit and debit" : "Bank-style · every payment received"}
                  trailing={<Ionicons color={colors.mutedForeground} name="document-text-outline" size={20} />}
                />
              ))}
              <SheetRow
                label={`Performance report · ${dates.period(selected)}`}
                onPress={() => {
                  setSheet(null);
                  void downloadPdf();
                }}
                subtitle="Rent, residents and listing for the month"
                trailing={<Ionicons color={colors.mutedForeground} name="bar-chart-outline" size={20} />}
              />
            </>
          );
        })()}
      </Sheet>

      <Sheet bare onClose={() => setSheet(null)} open={sheet === "exports"} title="Spreadsheets">
        {REPORT_EXPORTS.map((entry) => (
          <SheetRow
            key={entry.report}
            label={entry.label}
            onPress={() => {
              if (!exporting) {
                void exportCsv(entry.report);
              }
            }}
            subtitle="CSV, all months. No phone numbers or addresses"
            trailing={<Ionicons color={colors.mutedForeground} name="download-outline" size={20} />}
          />
        ))}
      </Sheet>

      <Sheet onClose={() => setSheet(null)} open={sheet === "night"} title="Night check-ins">
        {attendance ? (
          <View className="gap-4 pb-2">
            <Text variant="caption">
              {`Last ${attendance.summary.windowDays} days · ${plural(attendance.summary.pings, "check-in")}`}
            </Text>
            <Meter
              label={`${Math.round(attendance.summary.averageAttendanceRate * 100)}% accounted for`}
              percent={attendance.summary.averageAttendanceRate * 100}
            />
            <View className="flex-row flex-wrap gap-2">
              <Chip label={`Inside · ${attendance.summary.zones.inside}`} tone="brand" />
              <Chip label={`Nearby · ${attendance.summary.zones.nearby}`} />
              <Chip label={`Outside · ${attendance.summary.zones.outside}`} />
            </View>

            {attendance.frequentlyAbsent.length > 0 ? (
              <View className="gap-3 border-t border-border pt-3">
                <Text variant="label">Most often away</Text>
                {attendance.frequentlyAbsent.slice(0, 5).map((resident) => (
                  <View className="flex-row items-center justify-between gap-3" key={resident.residentId}>
                    <View className="flex-1">
                      <Text numberOfLines={1}>{resident.name}</Text>
                      <Text variant="caption">
                        {`Away ${resident.outside} of ${plural(resident.total, "night")}`}
                      </Text>
                    </View>
                    <Badge
                      label={`${Math.round(resident.attendanceRate * 100)}%`}
                      tone={resident.attendanceRate < 0.5 ? "warning" : "neutral"}
                    />
                  </View>
                ))}
              </View>
            ) : null}

            <Text variant="caption">Zones only, never locations.</Text>
          </View>
        ) : null}
      </Sheet>

      <Sheet onClose={() => setSheet(null)} open={sheet === "food"} title="Meal timing">
        {foodTiming ? (
          <View className="gap-4 pb-2">
            <View className="flex-row gap-3">
              <StatTile
                icon="notifications-outline"
                label="Announced"
                value={String(foodTiming.summary.totalAnnouncements)}
              />
              <StatTile
                icon="checkmark-circle-outline"
                label="On time"
                tone="success"
                value={String(foodTiming.summary.onTimeAnnouncements)}
              />
              <StatTile
                icon="time-outline"
                label="Late"
                tone={foodTiming.summary.lateAnnouncements > 0 ? "warning" : "neutral"}
                value={String(foodTiming.summary.lateAnnouncements)}
              />
            </View>

            {foodTiming.byMeal.map((meal) => (
              <View className="flex-row items-center justify-between gap-3" key={meal.mealType}>
                <View className="flex-1">
                  <Text variant="label">{humanizeEnum(meal.mealType)}</Text>
                  <Text variant="caption">
                    {`Usually ready ${clockTime(meal.averageReadyMinutes)}${meal.scheduledTiming ? ` · scheduled ${meal.scheduledTiming}` : ""}`}
                  </Text>
                </View>
                <Badge
                  label={delayLabel(meal.averageDelayMinutes)}
                  tone={
                    meal.averageDelayMinutes === null
                      ? "neutral"
                      : meal.averageDelayMinutes > 10
                        ? "warning"
                        : "success"
                  }
                />
              </View>
            ))}
          </View>
        ) : null}
      </Sheet>
    </Screen>
  );
}
