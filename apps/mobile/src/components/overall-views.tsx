import { Image } from "expo-image";
import { router } from "expo-router";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AdminHomeHeader, HostelHero, QuickActions, ServiceGrid, WaitingActions } from "@/components/admin-home";
import { HostelSwitcher, openInBranch } from "@/components/hostel-switcher";
import { NotificationBell } from "@/components/notification-bell";
import { AppBar } from "@/components/ui/app-bar";
import { Card, SectionHeader } from "@/components/ui/card";
import { Glyph } from "@/components/ui/glyph";
import { FactRow } from "@/components/ui/layout";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Meter } from "@/components/ui/meter";
import { Money } from "@/components/ui/money";
import { Screen } from "@/components/ui/screen";
import { Segmented } from "@/components/ui/segmented";
import { Sheet, SheetRow } from "@/components/ui/sheet";
import { SkeletonCard } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { API_BASE_URL } from "@/lib/api";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { overallPdfPath } from "@/lib/admin-manage-api";
import { readApiError } from "@/lib/api-contract";
import { downloadToDevice } from "@/lib/documents";
import { absoluteMediaUrl } from "@/lib/media";
import { expenseTitle, isSpending } from "@/lib/expenses";
import { formatMoney, humanizeEnum, nepalPeriodKey } from "@/lib/format";
import { creditTitle, splitTotals, statementCredits } from "@/lib/hostel-statement";
import {
  type BranchOverall,
  type FieldState,
  getOverallData,
  type OverallData,
  type OverallField,
  type OverallSection,
  type OverallValues,
} from "@/lib/overall-api";
import { toastError } from "@/lib/toast";
import type { GlyphName } from "@hostel/constants/glyphs";

/**
 * **Overall** as a branch (`lib/active-hostel.ts` → `OVERALL`).
 *
 * Picked in the switcher like any hostel, and then the same five tabs answer
 * for every branch at once: Home is the whole business, Residents is people,
 * Payments is money, More is daily work and reports. Each subject is **stacked
 * per branch** — the branch's name on the page, its own card under it — so two
 * branches' rows never mix into one list nobody can attribute.
 *
 * Read-only by construction: every request names its branch explicitly
 * (`overall-api.ts`), and every action starts by switching into the one branch
 * it belongs to. Owner only — the switcher that offers it reads the owner-only
 * branches summary, and a warden's token holds no other branch to read.
 */

export type OverallTab = "home" | "people" | "money" | "more";

type Topic =
  | "residents" | "wardens" | "cooks"
  | "payments" | "statement" | "expenses" | "billing"
  | "night" | "complaints" | "maintenance" | "inquiries" | "bookings" | "notices"
  | "performance" | "food" | "attendance";

const TOPICS: Record<Exclude<OverallSection, "overview">, readonly { label: string; value: Topic }[]> = {
  people: [
    { label: "Residents", value: "residents" },
    { label: "Wardens", value: "wardens" },
    { label: "Cooks", value: "cooks" },
  ],
  money: [
    { label: "Payments", value: "payments" },
    { label: "Statement", value: "statement" },
    { label: "Expenses", value: "expenses" },
    { label: "Plan", value: "billing" },
  ],
  operations: [
    { label: "Tonight", value: "night" },
    { label: "Complaints", value: "complaints" },
    { label: "Repairs", value: "maintenance" },
    { label: "Inquiries", value: "inquiries" },
    { label: "Bookings", value: "bookings" },
    { label: "Notices", value: "notices" },
  ],
  reports: [
    { label: "Performance", value: "performance" },
    { label: "Food", value: "food" },
    { label: "Attendance", value: "attendance" },
  ],
};

/** Where "Open in this branch" lands, once the switcher has moved into it. */
const TOPIC_ROUTES: Record<Topic, string> = {
  residents: "/(admin)/residents",
  wardens: "/manage/wardens",
  cooks: "/manage/cook",
  payments: "/(admin)/money",
  statement: "/manage/finance/statement",
  expenses: "/expenses",
  billing: "/manage/billing",
  night: "/manage/roll-call",
  complaints: "/manage/complaints",
  maintenance: "/manage/maintenance",
  inquiries: "/manage/inquiries",
  bookings: "/manage/bookings",
  notices: "/manage/notices",
  performance: "/manage/reports",
  food: "/manage/reports",
  attendance: "/manage/reports",
};

const TITLES: Record<OverallTab, string> = {
  home: "Overall",
  money: "Payments",
  more: "More",
  people: "Residents",
};

const MONEY_TOPICS = new Set<Topic>(["payments", "expenses", "performance"]);

function field<K extends OverallField>(row: BranchOverall, key: K): FieldState<OverallValues[K]> | undefined {
  return row.fields[key] as FieldState<OverallValues[K]> | undefined;
}

function openIn(branchId: string, isBranch: boolean, route: string) {
  openInBranch({ id: branchId, isBranch }, route);
}

/**
 * Where a branch Home's tile goes when Overall is picked: the all-branches view
 * of the same subject. A tile missing here is a per-branch job (rooms, settings,
 * a new resident) and asks which branch first.
 */
const OVERALL_HREFS: Record<string, string> = {
  "/(admin)/residents": "/(admin)/residents",
  "/expenses": "/overall/expenses",
  "/manage/billing": "/overall/billing",
  "/manage/complaints": "/overall/complaints",
  "/manage/cook": "/overall/cooks",
  "/manage/finance": "/(admin)/money",
  "/manage/finance/statement": "/manage/finance/statement",
  "/manage/food": "/overall/food",
  "/manage/inquiries": "/overall/inquiries",
  "/manage/maintenance": "/overall/maintenance",
  "/manage/notices": "/overall/notices",
  "/manage/reports": "/overall/performance",
  "/manage/roll-call": "/overall/night",
  "/manage/wardens": "/overall/wardens",
  "/stock": "/stock",
};

function go(route: string) {
  if (route.startsWith("/(admin)")) router.navigate(route as never);
  else router.push(route as never);
}

/* ------------------------------------------------------------------ shell */

/**
 * The tab's screen while Overall is picked. Same bar shape as every tab, with
 * the switcher on it so Overall can be left from wherever the owner is.
 */
export function OverallTabScreen({ tab }: { tab: OverallTab }) {
  const [section, setSection] = useState<OverallSection>(
    tab === "home" ? "overview" : tab === "people" ? "people" : tab === "money" ? "money" : "operations",
  );
  const period = nepalPeriodKey();
  const load = useCallback(() => getOverallData(section, period), [section, period]);
  const resource = useResource<OverallData>(load, { cacheKey: `admin:overall:${section}:${period}` });
  // The previous section's rows can linger while the next loads; never label them with the new one.
  const visible = resource.data?.section === section ? resource.data : null;

  return (
    <Screen
      header={
        tab === "home" ? (
          <AdminHomeHeader />
        ) : (
        <AppBar
          actions={
            <View className="flex-row items-center gap-1">
              <HostelSwitcher compact />
              <NotificationBell />
            </View>
          }
          large
          subtitle="All branches"
          title={TITLES[tab]}
        />
        )
      }
      insideTabs
      padded={tab !== "home"}
      onRefresh={resource.refresh}
      refreshing={resource.refreshing}
      scroll
    >
      <View className="gap-5 pb-6 pt-1">
        {tab === "more" ? (
          <>
            <Segmented
              onChange={(value) => setSection(value)}
              options={[
                { label: "Daily", value: "operations" as OverallSection },
                { label: "Reports", value: "reports" as OverallSection },
              ]}
              value={section}
            />
            {section === "reports" ? <OverallDownloads period={period} /> : null}
          </>
        ) : null}

        {resource.error && !visible ? (
          <View className={tab === "home" ? "px-5" : undefined}>
            <ErrorState message={resource.error} onRetry={resource.reload} />
          </View>
        ) : null}
        {!visible && !resource.error ? (
          <View className={tab === "home" ? "px-5" : undefined}>
            <SkeletonCard rows={4} />
          </View>
        ) : null}

        {visible ? (
          visible.branches.length === 0 ? (
            <Card>
              <Text variant="caption">No branches yet.</Text>
            </Card>
          ) : section === "overview" ? (
            <OverallHome period={visible.period} rows={visible.branches} />
          ) : (
            <StackedTopics rows={visible.branches} section={section} />
          )
        ) : null}

        {tab === "more" ? (
          <Card padding="px-4 py-1">
            <ListRow icon="git-branch-outline" onPress={() => router.push("/manage/branches")} title="Manage branches" />
          </Card>
        ) : null}
      </View>
    </Screen>
  );
}

const TOPIC_SECTION = Object.fromEntries(
  Object.entries(TOPICS).flatMap(([section, options]) => options.map((option) => [option.value, section])),
) as Partial<Record<string, Exclude<OverallSection, "overview">>>;

/**
 * One subject over every branch — where an Overall Home tile lands
 * (`app/overall/[topic].tsx`). The same stacked cards as the tabs, one topic.
 */
export function OverallTopicScreen({ topic }: { topic: string }) {
  const section = TOPIC_SECTION[topic];
  const label = section ? TOPICS[section].find((option) => option.value === topic)!.label : "Overall";
  const period = nepalPeriodKey();
  const load = useCallback(() => getOverallData(section ?? "people", period), [section, period]);
  const resource = useResource<OverallData>(load, { cacheKey: `admin:overall:${section ?? "people"}:${period}` });
  const visible = resource.data?.section === section ? resource.data : null;

  return (
    <Screen
      header={<AppBar showBack subtitle="All branches" title={label} />}
      onRefresh={resource.refresh}
      refreshing={resource.refreshing}
      scroll
    >
      <View className="gap-5 pb-6 pt-1">
        {!section ? <ErrorState message="This page does not exist." /> : null}
        {section && resource.error && !visible ? <ErrorState message={resource.error} onRetry={resource.reload} /> : null}
        {section && !visible && !resource.error ? <SkeletonCard rows={4} /> : null}
        {section && visible ? (
          visible.branches.length === 0 ? (
            <Card>
              <Text variant="caption">No branches yet.</Text>
            </Card>
          ) : (
            <StackedTopics fixed={topic as Topic} rows={visible.branches} section={section} />
          )
        ) : null}
      </View>
    </Screen>
  );
}

/* ------------------------------------------------------------------- home */

function Figure({ label, children }: { children: ReactNode; label: string }) {
  return (
    <View className="flex-1 gap-0.5">
      <Text variant="caption">{label}</Text>
      {children}
    </View>
  );
}

function HostelMark({ coverUrl, isBranch, size = 40 }: { coverUrl?: string | null; isBranch: boolean; size?: number }) {
  const { colors } = useAppTheme();
  const photo = absoluteMediaUrl(coverUrl, API_BASE_URL);

  if (photo) {
    return <Image contentFit="cover" source={{ uri: photo }} style={{ borderRadius: 12, height: size, width: size }} />;
  }

  return (
    <View className="items-center justify-center rounded-xl bg-brand-soft" style={{ height: size, width: size }}>
      <Glyph color={colors.primary} name={isBranch ? "branch" : "hostel"} size={Math.round(size / 2)} />
    </View>
  );
}

/**
 * A branch's Home, answered for every branch: the same hero (summed), the same
 * shortcut row, "Waiting for you" and Manage grid, then each branch as a card.
 * A tile opens the all-branches view of its subject; a per-branch job asks
 * which branch first and switches into it.
 */
function OverallHome({ period, rows }: { period: string; rows: BranchOverall[] }) {
  const { colors } = useAppTheme();
  const [picking, setPicking] = useState<string | null>(null);
  const totals = rows.reduce(
    (sum, row) => ({
      beds: sum.beds + row.branch.beds,
      collected: sum.collected + row.branch.collected,
      complaints: sum.complaints + row.branch.openComplaints,
      due: sum.due + row.branch.due,
      residents: sum.residents + row.branch.residents,
    }),
    { beds: 0, collected: 0, complaints: 0, due: 0, residents: 0 },
  );
  const billed = totals.collected + totals.due;

  const open = (route: string) => {
    const overall = OVERALL_HREFS[route];

    if (overall) go(overall);
    else if (rows.length === 1) openIn(rows[0]!.branch.id, rows[0]!.branch.isBranch, route);
    else setPicking(route);
  };

  return (
    <View>
      {/* The branch Home's own hero card, summed over every branch. */}
      <HostelHero
        delta={null}
        earnings={{
          lifetime: null,
          outstanding: totals.due,
          outstandingIsLifetime: false,
          period,
          thisMonth: totals.collected,
          thisMonthBilled: billed,
        }}
        hostel={null}
        occupancy={totals.beds > 0 ? Math.round((totals.residents / totals.beds) * 100) : null}
        onSos={() => router.push("/(admin)/alerts")}
        residents={totals.residents}
        sosCount={0}
        vacantBeds={Math.max(0, totals.beds - totals.residents)}
      />

      <View className="pt-3">
        <QuickActions
          onAddExpense={() => open("/expenses/new")}
          onNewResident={() => open("/manage/resident/new")}
          onRollCall={() => open("/manage/roll-call")}
          onScan={() => open("/manage/scan")}
        />
      </View>

      <View className="gap-6 px-5 pt-6">
        <View>
          <SectionHeader title="Money & stock" />
          <WaitingActions
            onExpenses={() => open("/expenses")}
            onFinance={() => open("/manage/finance")}
            // No per-branch count in Overall: the tile shows, without a badge.
            khataPending={0}
            onKhata={() => open("/manage/finance/khata")}
            onStatement={() => open("/manage/finance/statement")}
            onStock={() => open("/stock")}
          />
        </View>

        <View>
          <SectionHeader title="Manage" />
          <ServiceGrid onOpen={open} owner />
        </View>

        <View className="gap-3">
          <SectionHeader title="Branches" />
          {rows.map(({ branch }) => (
            <Pressable
              accessibilityHint="Opens this branch"
              accessibilityRole="button"
              className="gap-3 rounded-2xl border border-border bg-card p-4 active:opacity-80"
              key={branch.id}
              onPress={() => openIn(branch.id, branch.isBranch, "/(admin)")}
            >
              <View className="flex-row items-center gap-3">
                <HostelMark coverUrl={branch.coverUrl} isBranch={branch.isBranch} />
                <View className="min-w-0 flex-1">
                  <Text numberOfLines={1} variant="subtitle">
                    {branch.name}
                  </Text>
                  <Text numberOfLines={1} variant="caption">
                    {[branch.isBranch ? "Branch" : "Main", branch.area || branch.city].filter(Boolean).join(" · ")}
                  </Text>
                </View>
                <Glyph color={colors.mutedForeground} name="chevron" size={16} />
              </View>
              <Meter
                label={`${branch.residents} of ${branch.beds} beds`}
                percent={branch.occupancyPercent}
                reading="share"
              />
              <View className="flex-row">
                <Figure label="Collected">
                  <Money tone="credit" value={branch.collected} />
                </Figure>
                <Figure label="Due">
                  <Money owed={branch.due > 0} value={branch.due} />
                </Figure>
                <Figure label="Complaints">
                  <Text className={branch.openComplaints > 0 ? "text-warning" : undefined} variant="label">
                    {String(branch.openComplaints)}
                  </Text>
                </Figure>
              </View>
            </Pressable>
          ))}
        </View>
      </View>

      {/* A write belongs to one branch: pick it, and the app moves there. */}
      <Sheet bare fitContent onClose={() => setPicking(null)} open={picking !== null} title="Which branch?">
        <View className="px-4 py-4">
          <View className="overflow-hidden rounded-2xl bg-card">
            {rows.map(({ branch }, at) => (
              <View key={branch.id}>
                {at ? <View className="ml-[72px] h-px bg-border" /> : null}
                <SheetRow
                  label={branch.name}
                  leading={<HostelMark coverUrl={branch.coverUrl} isBranch={branch.isBranch} />}
                  onPress={() => {
                    const route = picking;

                    setPicking(null);
                    if (route) openIn(branch.id, branch.isBranch, route);
                  }}
                  subtitle={branch.isBranch ? "Branch" : "Main hostel"}
                />
              </View>
            ))}
          </View>
        </View>
      </Sheet>
    </View>
  );
}

/* ------------------------------------------------------------- downloads */

function OverallDownloads({ period }: { period: string }) {
  const { colors } = useAppTheme();
  const [busy, setBusy] = useState<string | null>(null);

  const download = async (kind: "report" | "statement") => {
    setBusy(kind);

    try {
      await downloadToDevice({
        extension: "pdf",
        fileName: `overall-${kind}-${period}`,
        label: kind === "report" ? "All branches report" : "All branches statement",
        mimeType: "application/pdf",
        url: `${API_BASE_URL}${overallPdfPath(kind, period)}`,
      });
    } catch (error) {
      toastError("Could not download", readApiError(error, "The PDF did not download."));
    } finally {
      setBusy(null);
    }
  };

  const tile = (kind: "report" | "statement", glyph: GlyphName, label: string) => (
    <Pressable
      accessibilityRole="button"
      className="flex-1 items-center gap-2 rounded-2xl border border-border bg-card p-4 active:opacity-70"
      disabled={busy !== null}
      onPress={() => void download(kind)}
    >
      <View className="h-12 w-12 items-center justify-center rounded-2xl bg-brand-soft">
        <Glyph color={colors.primary} name={glyph} size={22} />
      </View>
      <Text variant="label">{busy === kind ? "Preparing…" : label}</Text>
      <Text variant="caption">PDF · this month</Text>
    </Pressable>
  );

  return (
    <View className="flex-row gap-3">
      {tile("report", "reports", "Report")}
      {tile("statement", "money", "Statement")}
    </View>
  );
}

/* --------------------------------------------------------------- stacked */

function TopicChips({ onChange, options, value }: {
  onChange: (value: Topic) => void;
  options: readonly { label: string; value: Topic }[];
  value: Topic;
}) {
  return (
    <ScrollView contentContainerClassName="gap-2 pr-4" horizontal showsHorizontalScrollIndicator={false}>
      {options.map((option) => {
        const active = option.value === value;

        return (
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            className={`rounded-full border px-4 py-2.5 active:opacity-70 ${active ? "border-primary bg-primary" : "border-border bg-card"}`}
            key={option.value}
            onPress={() => onChange(option.value)}
          >
            <Text className={active ? "font-semibold text-primary-foreground" : "text-foreground"} variant="label">
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/** One subject, every branch: the total on top, then each branch's own card. */
function StackedTopics({ fixed, rows, section }: {
  /** One subject only, no chips — the single-topic screen a Home tile opens. */
  fixed?: Topic;
  rows: BranchOverall[];
  section: Exclude<OverallSection, "overview">;
}) {
  const options = TOPICS[section];
  const [picked, setPicked] = useState<Topic>(fixed ?? options[0]!.value);
  const topic = fixed ?? (options.some((option) => option.value === picked) ? picked : options[0]!.value);
  // Plan billing lives on the main hostel only: one plan covers its branches.
  const shown = useMemo(
    () => (topic === "billing" ? rows.filter((row) => !row.branch.isBranch) : rows),
    [rows, topic],
  );

  return (
    <View className="gap-5">
      {fixed ? null : <TopicChips onChange={setPicked} options={options} value={topic} />}
      <TopicTotal rows={rows} topic={topic} />
      {shown.map((row) => (
        <View className="gap-2" key={row.branch.id}>
          {/* The branch heading sits on the page, outside its card (NOTES §5). */}
          <View className="flex-row items-center gap-2 px-1">
            <HostelMark isBranch={row.branch.isBranch} size={24} />
            <Text className="flex-1" numberOfLines={1} variant="label">
              {row.branch.name}
            </Text>
            <Text className="font-semibold text-foreground" variant={null}>
              {formatTopic(topic, topicValue(row, topic))}
            </Text>
          </View>
          <Card className="gap-2">
            <TopicBody row={row} topic={topic} />
            <Pressable
              accessibilityRole="button"
              className="flex-row items-center justify-center gap-1 pt-1 active:opacity-70"
              onPress={() => openIn(row.branch.id, row.branch.isBranch, TOPIC_ROUTES[topic])}
            >
              <Text className="font-semibold text-primary" variant="label">
                Open in this branch
              </Text>
            </Pressable>
          </Card>
        </View>
      ))}
    </View>
  );
}

function topicValue(row: BranchOverall, topic: Topic): number | null {
  switch (topic) {
    case "residents": return row.branch.residents;
    case "wardens": return field(row, "wardens")?.data?.pagination?.total ?? field(row, "wardens")?.data?.wardens.length ?? null;
    case "cooks": return field(row, "cooks")?.data?.cooks.filter((person) => person.status === "ACTIVE").length ?? null;
    case "payments": return field(row, "invoices")?.data?.totals.collected ?? null;
    case "expenses": return field(row, "expenses")?.data?.totals?.out ?? null;
    case "night": return field(row, "night")?.data?.summary.OUTSIDE_HOSTEL ?? null;
    case "complaints": return row.branch.openComplaints;
    case "maintenance": return field(row, "maintenance")?.data?.summary.open ?? null;
    case "inquiries": return field(row, "inquiries")?.data?.pagination?.total ?? field(row, "inquiries")?.data?.inquiries.length ?? null;
    case "bookings": return field(row, "bookings")?.data?.counts.requests ?? null;
    case "notices": return field(row, "notices")?.data?.pagination?.total ?? field(row, "notices")?.data?.notices.length ?? null;
    case "performance": return field(row, "performance")?.data?.report.finance.collected ?? null;
    case "food": return field(row, "food")?.data?.summary.lateAnnouncements ?? null;
    case "attendance": return field(row, "attendance")?.data?.summary.residentsTracked ?? null;
    case "statement":
    case "billing": return null;
  }
}

const TOTAL_LABEL: Partial<Record<Topic, string>> = {
  attendance: "Residents tracked",
  bookings: "Booking requests",
  complaints: "Open complaints",
  cooks: "Active cooks",
  expenses: "Spent this month",
  food: "Late meal notices",
  inquiries: "Inquiries",
  maintenance: "Open repairs",
  night: "Outside tonight",
  notices: "Notices",
  payments: "Collected this month",
  performance: "Collected this month",
  residents: "Residents",
  wardens: "Wardens",
};

function formatTopic(topic: Topic, value: number | null) {
  if (value === null) return "";
  return MONEY_TOPICS.has(topic) ? formatMoney(value) : String(value);
}

function TopicTotal({ rows, topic }: { rows: BranchOverall[]; topic: Topic }) {
  if (!TOTAL_LABEL[topic]) return null;

  const values = rows.map((row) => topicValue(row, topic));
  const loaded = values.filter((value): value is number => value !== null);
  const complete = loaded.length === rows.length;

  return (
    <Card className="flex-row items-center gap-3">
      <View className="flex-1 gap-0.5">
        <Text variant="caption">{`${TOTAL_LABEL[topic]} · all branches`}</Text>
        <Text variant="title">{complete ? formatTopic(topic, loaded.reduce((sum, value) => sum + value, 0)) : "—"}</Text>
      </View>
      {!complete ? <Text variant="caption">{`${loaded.length} of ${rows.length} loaded`}</Text> : null}
    </Card>
  );
}

function Issue({ label, state }: { label: string; state: { error: string | null } | undefined }) {
  return state?.error ? (
    <Text className="text-warning" variant="caption">{`${label}: ${state.error}`}</Text>
  ) : null;
}

/** First rows of a list, with "Show more" growing it here up to 20. */
function Preview({ empty, items, total }: { empty: string; items: ReactNode[]; total?: number }) {
  const [more, setMore] = useState(false);

  if (items.length === 0) return <Text variant="caption">{empty}</Text>;

  const shown = Math.min(items.length, more ? 20 : 3);

  return (
    <View>
      {items.slice(0, shown).map((item, index) => (
        <View key={index}>
          {index > 0 ? <RowDivider inset /> : null}
          {item}
        </View>
      ))}
      {items.length > 3 ? (
        <Pressable accessibilityRole="button" className="py-2 active:opacity-70" onPress={() => setMore((value) => !value)}>
          <Text className="font-medium text-primary" variant="label">
            {more ? "Show fewer" : `Show ${Math.min(items.length, 20) - 3} more`}
          </Text>
        </Pressable>
      ) : null}
      {(total ?? items.length) > shown && more ? (
        <Text variant="caption">{`${shown} of ${total ?? items.length}`}</Text>
      ) : null}
    </View>
  );
}

function TopicBody({ row, topic }: { row: BranchOverall; topic: Topic }) {
  const open = (route: string) => openIn(row.branch.id, row.branch.isBranch, route);

  switch (topic) {
    case "residents": {
      const state = field(row, "residents");
      return <>
        <Issue label="Residents" state={state} />
        {state?.data ? <Preview empty="No residents yet." total={state.data.pagination?.total} items={state.data.residents.map((person) =>
          <ListRow icon="person-outline" key={person.id} onPress={() => open(`/manage/resident/${person.id}`)}
            subtitle={[humanizeEnum(person.roomType), humanizeEnum(person.status)].filter(Boolean).join(" · ")}
            title={`${person.firstName} ${person.lastName}`.trim()} />)} /> : null}
      </>;
    }
    case "wardens": {
      const state = field(row, "wardens");
      return <>
        <Issue label="Wardens" state={state} />
        {state?.data ? <Preview empty="No wardens yet." total={state.data.pagination?.total} items={state.data.wardens.map((person) =>
          <ListRow icon="shield-outline" key={person.id} onPress={() => open(TOPIC_ROUTES.wardens)}
            subtitle={humanizeEnum(person.status)} title={person.name} />)} /> : null}
      </>;
    }
    case "cooks": {
      const state = field(row, "cooks");
      return <>
        <Issue label="Cooks" state={state} />
        {state?.data ? <Preview empty="No cooks yet." items={state.data.cooks.map((person) =>
          <ListRow icon="restaurant-outline" key={person.id} onPress={() => open(TOPIC_ROUTES.cooks)}
            subtitle={humanizeEnum(person.status)} title={person.name} />)} /> : null}
      </>;
    }
    case "payments": {
      const invoices = field(row, "invoices");
      const totals = invoices?.data?.totals;
      return <>
        <Issue label="Payments" state={invoices} />
        {totals ? <>
          <View className="flex-row">
            <Figure label="Billed"><Money value={totals.due} /></Figure>
            <Figure label="Collected"><Money tone="credit" value={totals.collected} /></Figure>
            <Figure label="Due"><Money owed={totals.due > totals.collected} value={Math.max(0, totals.due - totals.collected)} /></Figure>
          </View>
          <Meter label={null} percent={totals.due > 0 ? Math.round((totals.collected / totals.due) * 100) : null} />
          <Preview empty="Everyone has paid." items={invoices.data!.rows
            .filter((item) => item.payment && item.payment.dueAmount > item.payment.paidAmount)
            .map((item) => <ListRow icon="person-outline" key={item.resident.id} onPress={() => open(TOPIC_ROUTES.payments)}
              subtitle={item.resident.roomNumber ?? item.resident.roomType ?? ""}
              title={item.resident.fullName}
              right={<Money owed value={(item.payment?.dueAmount ?? 0) - (item.payment?.paidAmount ?? 0)} />} />)} />
        </> : null}
      </>;
    }
    case "statement": {
      const state = field(row, "ledger");
      const credits = state?.data ? statementCredits(state.data) : [];
      const sums = splitTotals(credits);
      return <>
        <Issue label="Statement" state={state} />
        {state?.data ? <>
          <View className="flex-row">
            <Figure label="Money in"><Money tone="credit" value={sums.in} /></Figure>
            <Figure label="Money out"><Money tone="debit" value={sums.out} /></Figure>
            <Figure label="Net"><Money value={sums.in - sums.out} /></Figure>
          </View>
          <Preview empty="Nothing moved yet." items={credits.map((credit) =>
            <ListRow icon={credit.transfer ? "swap-horizontal" : credit.debit ? "arrow-down" : "arrow-up"} key={credit.id}
              onPress={() => open(TOPIC_ROUTES.statement)} title={creditTitle(credit, "BS")}
              right={<Money tone={credit.transfer ? "default" : credit.debit ? "debit" : "credit"} value={credit.amount} />} />)} />
        </> : null}
      </>;
    }
    case "expenses": {
      const state = field(row, "expenses");
      const home = state?.data;
      const withStaff = (home?.wallets ?? []).reduce((sum, wallet) => sum + Math.max(0, wallet.left), 0);
      return <>
        <Issue label="Expenses" state={state} />
        {home ? <>
          <View className="flex-row">
            <Figure label="Spent"><Money tone="debit" value={home.totals?.out ?? home.mine.out} /></Figure>
            <Figure label="With staff"><Money value={withStaff} /></Figure>
          </View>
          {(home.wallets ?? []).map((wallet) => (
            <FactRow key={wallet.userId} label={wallet.name}
              value={wallet.left < 0 ? `Owes ${formatMoney(-wallet.left)}` : `${formatMoney(wallet.left)} left`} />
          ))}
          <Preview empty="Nothing spent this month." items={home.expenses.filter(isSpending).map((item) =>
            <ListRow icon="wallet-outline" key={item.id} onPress={() => open(TOPIC_ROUTES.expenses)}
              subtitle={[item.categoryLabel, item.payer === "STAFF" ? item.recordedBy.name : null].filter(Boolean).join(" · ")}
              title={expenseTitle(item)} right={<Money tone="debit" value={item.amount} />} />)} />
        </> : null}
      </>;
    }
    case "billing": {
      const state = field(row, "billing");
      return <>
        <Issue label="Plan" state={state} />
        {state?.data ? <>
          <FactRow label="Plan" value={state.data.history.plan?.planName ?? "No plan"} />
          <FactRow label="Status" value={humanizeEnum(state.data.history.plan?.status ?? "NOT_SET")} />
          <FactRow label="Open bills" value={String(state.data.history.invoices.filter((item) => item.outstanding > 0).length)} />
        </> : null}
      </>;
    }
    case "night": {
      const night = field(row, "night");
      return <>
        <Issue label="Tonight" state={night} />
        {night?.data ? <>
          <View className="flex-row">
            <Figure label="Inside"><Text variant="subtitle">{String(night.data.summary.INSIDE_HOSTEL)}</Text></Figure>
            <Figure label="Outside"><Text variant="subtitle">{String(night.data.summary.OUTSIDE_HOSTEL)}</Text></Figure>
            <Figure label="Not checked"><Text variant="subtitle">{String(night.data.summary.NOT_VERIFIED)}</Text></Figure>
          </View>
          <Preview empty="Everyone is inside." items={night.data.statuses.filter((item) => item.status.status !== "INSIDE_HOSTEL").map((item) =>
            <ListRow icon="moon-outline" key={item.resident.id} onPress={() => open(TOPIC_ROUTES.night)}
              subtitle={humanizeEnum(item.status.status)} title={item.resident.fullName} />)} />
        </> : null}
      </>;
    }
    case "complaints": {
      const state = field(row, "complaints");
      return <>
        <Issue label="Complaints" state={state} />
        {state?.data ? <Preview empty="No complaints." total={state.data.pagination?.total} items={state.data.complaints.map((item) =>
          <ListRow icon="chatbox-outline" key={item.id} onPress={() => open(TOPIC_ROUTES.complaints)}
            subtitle={`${humanizeEnum(item.status)}${item.isOverdue ? " · Overdue" : ""}`} title={item.title} />)} /> : null}
      </>;
    }
    case "maintenance": {
      const state = field(row, "maintenance");
      return <>
        <Issue label="Repairs" state={state} />
        {state?.data ? <Preview empty="No repairs." items={state.data.requests.map((item) =>
          <ListRow icon="construct-outline" key={item.id} onPress={() => open(TOPIC_ROUTES.maintenance)}
            subtitle={`${humanizeEnum(item.status)} · ${item.location}`} title={item.title} />)} /> : null}
      </>;
    }
    case "inquiries": {
      const state = field(row, "inquiries");
      return <>
        <Issue label="Inquiries" state={state} />
        {state?.data ? <Preview empty="No inquiries." total={state.data.pagination?.total} items={state.data.inquiries.map((item) =>
          <ListRow icon="mail-outline" key={item.id} onPress={() => open(TOPIC_ROUTES.inquiries)}
            subtitle={humanizeEnum(item.status)} title={item.name} />)} /> : null}
      </>;
    }
    case "bookings": {
      const state = field(row, "bookings");
      return <>
        <Issue label="Bookings" state={state} />
        {state?.data ? <Preview empty="No requests." items={state.data.bookings.map((item) =>
          <ListRow icon="calendar-outline" key={item.id} onPress={() => open(TOPIC_ROUTES.bookings)}
            subtitle={`${item.roomType} · ${item.statusLabel}`} title={item.guest.name} />)} /> : null}
      </>;
    }
    case "notices": {
      const state = field(row, "notices");
      return <>
        <Issue label="Notices" state={state} />
        {state?.data ? <Preview empty="No notices." total={state.data.pagination?.total} items={state.data.notices.map((item) =>
          <ListRow icon="megaphone-outline" key={item.id} onPress={() => open(TOPIC_ROUTES.notices)}
            subtitle={humanizeEnum(item.category)} title={item.title} />)} /> : null}
      </>;
    }
    case "performance": {
      const report = field(row, "performance")?.data?.report;
      return <>
        <Issue label="Report" state={field(row, "performance")} />
        {report ? <>
          <View className="flex-row">
            <Figure label="Billed"><Money value={report.finance.billed} /></Figure>
            <Figure label="Collected"><Money tone="credit" value={report.finance.collected} /></Figure>
            <Figure label="Due"><Money owed={report.finance.outstanding > 0} value={report.finance.outstanding} /></Figure>
          </View>
          <FactRow label="Residents" value={String(report.residents.now.total)} />
          <FactRow label="In / out" value={`${report.residents.movedIn} / ${report.residents.movedOut}`} />
          <FactRow label="Open complaints / repairs" value={`${report.operations.complaints.open} / ${report.operations.repairs.open}`} />
        </> : null}
      </>;
    }
    case "food": {
      const state = field(row, "food");
      return <>
        <Issue label="Food" state={state} />
        {state?.data ? <>
          <FactRow label="Meals announced" value={String(state.data.summary.totalAnnouncements)} />
          <FactRow label="Late" value={String(state.data.summary.lateAnnouncements)} />
        </> : null}
      </>;
    }
    case "attendance": {
      const state = field(row, "attendance");
      return <>
        <Issue label="Attendance" state={state} />
        {state?.data ? <>
          <Meter label={`${Math.round(state.data.summary.averageAttendanceRate * 100)}% average`}
            percent={Math.round(state.data.summary.averageAttendanceRate * 100)} />
          <FactRow label="Residents tracked" value={String(state.data.summary.residentsTracked)} />
        </> : null}
      </>;
    }
  }
}
