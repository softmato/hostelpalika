import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { HostelSwitcher } from "@/components/hostel-switcher";
import { AppBar } from "@/components/ui/app-bar";
import { Card, SectionHeader } from "@/components/ui/card";
import { FactRow } from "@/components/ui/layout";
import { ListRow } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Segmented } from "@/components/ui/segmented";
import { Sheet, SheetRow } from "@/components/ui/sheet";
import { SkeletonCard } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { ROLE } from "@/constants/roles";
import { useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { setActiveHostelId } from "@/lib/active-hostel";
import { formatMoney, humanizeEnum, nepalPeriodKey } from "@/lib/format";
import {
  type BranchOverall,
  type FieldState,
  getOverallData,
  type OverallData,
  type OverallField,
  type OverallSection,
  type OverallValues,
} from "@/lib/overall-api";

const SECTIONS: { label: string; value: OverallSection }[] = [
  { label: "Summary", value: "overview" },
  { label: "People", value: "people" },
  { label: "Money", value: "money" },
  { label: "Daily work", value: "operations" },
  { label: "Reports", value: "reports" },
];

type Topic =
  | "residents" | "wardens" | "cooks"
  | "payments" | "statement" | "expenses" | "billing"
  | "night" | "complaints" | "maintenance" | "inquiries" | "bookings" | "notices"
  | "performance" | "food" | "attendance";

const TOPICS: Record<OverallSection, readonly { label: string; value: Topic }[]> = {
  overview: [],
  people: [
    { label: "Residents", value: "residents" },
    { label: "Wardens", value: "wardens" },
    { label: "Cooks", value: "cooks" },
  ],
  money: [
    { label: "Payments", value: "payments" },
    { label: "Statement", value: "statement" },
    { label: "Expenses", value: "expenses" },
    { label: "Plan billing", value: "billing" },
  ],
  operations: [
    { label: "Tonight", value: "night" },
    { label: "Complaints", value: "complaints" },
    { label: "Maintenance", value: "maintenance" },
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

/** The full branch navigation stays available without occupying every topic card. */
const BRANCH_PAGES = [
  { group: "People", pages: [
    { title: "Residents", route: "/(admin)/residents" },
    { title: "Existing residents", route: "/manage/existing-residents" },
    { title: "Move history", route: "/manage/move-history" },
    { title: "Wardens", route: "/manage/wardens" },
    { title: "Cooks", route: "/manage/cook" },
    { title: "Join requests", route: "/manage/join-requests" },
  ] },
  { group: "Money", pages: [
    { title: "Payments", route: "/(admin)/money" },
    { title: "Statement", route: "/manage/finance/statement" },
    { title: "Expenses", route: "/expenses" },
    { title: "Finance", route: "/manage/finance" },
    { title: "Rates", route: "/manage/finance/rates" },
    { title: "Payment setup", route: "/manage/finance/payment-setup" },
    { title: "Bank reconciliation", route: "/manage/statements" },
    { title: "Plan billing", route: "/manage/billing" },
  ] },
  { group: "Daily work", pages: [
    { title: "Today", route: "/(admin)/today" },
    { title: "Night status", route: "/manage/roll-call" },
    { title: "Attendance", route: "/manage/attendance" },
    { title: "Complaints", route: "/manage/complaints" },
    { title: "Maintenance", route: "/manage/maintenance" },
    { title: "Food", route: "/manage/food" },
    { title: "Rooms", route: "/manage/rooms" },
    { title: "Bookings", route: "/manage/bookings" },
    { title: "Inquiries", route: "/manage/inquiries" },
    { title: "Notices", route: "/manage/notices" },
    { title: "Push notices", route: "/manage/push-notices" },
    { title: "Announcements", route: "/manage/announcements" },
  ] },
  { group: "Reports and setup", pages: [
    { title: "Reports", route: "/manage/reports" },
    { title: "Referrals", route: "/manage/referrals" },
    { title: "Hostel KYC", route: "/manage/kyc" },
    { title: "Settings", route: "/manage/settings" },
    { title: "Branches", route: "/manage/branches" },
  ] },
] as const;

function field<K extends OverallField>(row: BranchOverall, key: K): FieldState<OverallValues[K]> | undefined {
  return row.fields[key] as FieldState<OverallValues[K]> | undefined;
}

function Issue({ label, state }: { label: string; state: { error: string | null } | undefined }) {
  return state?.error ? (
    <Text className="text-warning" variant="caption">{label} could not load: {state.error}</Text>
  ) : null;
}

function SmallMetric({ label, value, warning = false }: { label: string; value: string; warning?: boolean }) {
  return (
    <View className="min-w-0 flex-1 gap-0.5">
      <Text variant="caption">{label}</Text>
      <Text className={warning ? "font-semibold text-warning" : "font-semibold text-foreground"}>{value}</Text>
    </View>
  );
}

function BranchCard({ children, row }: { children: ReactNode; row: BranchOverall }) {
  const location = [row.branch.area, row.branch.city].filter(Boolean).join(", ");
  return (
    <Card className="gap-3">
      <View className="gap-0.5">
        <Text variant="subtitle">{row.branch.name}</Text>
        <Text variant="caption">
          {[row.branch.isBranch ? "Branch" : "Main hostel", location, humanizeEnum(row.branch.status)]
            .filter(Boolean).join(" · ")}
        </Text>
      </View>
      <View className="border-t border-border pt-2">{children}</View>
    </Card>
  );
}

function TopicPicker({ onChange, options, value }: {
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
            className={`rounded-full border px-4 py-2.5 active:opacity-70 ${active ? "border-primary bg-brand-soft" : "border-border bg-card"}`}
            key={option.value}
            onPress={() => onChange(option.value)}
          >
            <Text className={active ? "font-semibold text-primary" : "text-foreground"} variant="label">
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/** A short preview by default; the branch screen is the complete, paginated record. */
function PreviewRows({ empty, expanded, items, onToggle, total }: {
  empty: string;
  expanded: boolean;
  items: ReactNode[];
  onToggle: () => void;
  total?: number;
}) {
  if (items.length === 0) return <Text variant="caption">{empty}</Text>;
  const shown = Math.min(items.length, expanded ? 20 : 3);
  return (
    <View>
      {items.slice(0, shown)}
      {items.length > 3 ? (
        <Pressable accessibilityRole="button" className="py-2 active:opacity-70" onPress={onToggle}>
          <Text className="font-medium text-primary" variant="label">
            {expanded ? "Show fewer" : `Show more here (${Math.min(items.length, 20) - 3})`}
          </Text>
        </Pressable>
      ) : null}
      {(total ?? items.length) > shown ? (
        <Text variant="caption">Showing {shown} of {total ?? items.length}. Open this branch for the full list.</Text>
      ) : null}
    </View>
  );
}

function SummaryView({ onOpen, onPages, rows, period }: {
  onOpen: (row: BranchOverall, route: string) => void;
  onPages: (row: BranchOverall) => void;
  rows: BranchOverall[];
  period: string;
}) {
  const totals = rows.reduce((sum, row) => ({
    beds: sum.beds + row.branch.beds,
    collected: sum.collected + row.branch.collected,
    complaints: sum.complaints + row.branch.openComplaints,
    outstanding: sum.outstanding + row.branch.due,
    residents: sum.residents + row.branch.residents,
  }), { beds: 0, collected: 0, complaints: 0, outstanding: 0, residents: 0 });

  return (
    <View className="gap-5">
      <Card className="gap-2">
        <Text variant="label">Across {rows.length} hostels · {period}</Text>
        <FactRow label="Residents / beds" value={`${totals.residents} / ${totals.beds}`} />
        <FactRow label="Collected this month" value={formatMoney(totals.collected)} />
        <FactRow label="Still outstanding" value={formatMoney(totals.outstanding)} />
        <FactRow label="Open complaints" value={String(totals.complaints)} />
      </Card>
      <View>
        <SectionHeader title="By hostel" subtitle="Compare each location, then open it for full records." />
        <View className="gap-3">
          {rows.map((row) => (
            <BranchCard key={row.branch.id} row={row}>
              <View className="gap-3">
                <View className="flex-row gap-3">
                  <SmallMetric label="Residents / beds" value={`${row.branch.residents} / ${row.branch.beds}`} />
                  <SmallMetric label="Still outstanding" value={formatMoney(row.branch.due)} />
                </View>
                <View className="flex-row gap-3">
                  <SmallMetric label="Collected this month" value={formatMoney(row.branch.collected)} />
                  <SmallMetric label="Open complaints" value={String(row.branch.openComplaints)} warning={row.branch.openComplaints > 0} />
                </View>
                <View className="border-t border-border pt-1">
                  <ListRow icon="bed-outline" title="Rooms and rates"
                    subtitle={field(row, "profile")?.data
                      ? `${field(row, "profile")?.data?.hostel.capacitySummary.vacantBeds ?? 0} beds open · ${field(row, "profile")?.data?.hostel.roomConfigurations.length ?? 0} room types`
                      : "View this hostel's rooms"}
                    onPress={() => onOpen(row, "/manage/rooms")} />
                  <Issue label="Rooms and rates" state={field(row, "profile")} />
                  <ListRow icon="business-outline" title="Open branch dashboard" onPress={() => onOpen(row, "/(admin)")} />
                  <ListRow icon="grid-outline" title="Browse all branch screens" onPress={() => onPages(row)} />
                </View>
              </View>
            </BranchCard>
          ))}
        </View>
      </View>
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
    case "performance": return field(row, "performance")?.data?.report.finance.outstanding ?? null;
    case "food": return field(row, "food")?.data?.summary.lateAnnouncements ?? null;
    case "attendance": return field(row, "attendance")?.data?.summary.residentsTracked ?? null;
    case "statement":
    case "billing": return null;
  }
}

const TOTAL_LABEL: Partial<Record<Topic, string>> = {
  residents: "Current residents",
  wardens: "Wardens",
  cooks: "Active cooks",
  payments: "Collected this month",
  expenses: "Spent this month",
  night: "Outside tonight",
  complaints: "Open complaints",
  maintenance: "Open maintenance",
  inquiries: "Inquiries",
  bookings: "Booking requests",
  notices: "Notices",
  performance: "Report outstanding",
  food: "Late announcements in report",
  attendance: "Residents tracked in report",
};

function TopicTotal({ rows, topic }: { rows: BranchOverall[]; topic: Topic }) {
  if (topic === "statement" || topic === "billing" || rows.length === 0) return null;
  const values = rows.map((row) => topicValue(row, topic));
  const loaded = values.filter((value): value is number => value !== null);
  const complete = loaded.length === rows.length;
  const amount = topic === "payments" || topic === "expenses" || topic === "performance";
  return (
    <Card className="gap-1">
      <Text variant="caption">Across {rows.length} hostels</Text>
      <Text variant="label">{TOTAL_LABEL[topic]}</Text>
      <Text variant="title">{complete ? (amount ? formatMoney(loaded.reduce((sum, value) => sum + value, 0)) : String(loaded.reduce((sum, value) => sum + value, 0))) : "Incomplete"}</Text>
      {!complete ? <Text variant="caption">{loaded.length} of {rows.length} hostels loaded. Check the branch messages below.</Text> : null}
    </Card>
  );
}

function TopicBody({ expanded, onOpen, onToggle, row, topic }: {
  expanded: boolean;
  onOpen: (route: string) => void;
  onToggle: () => void;
  row: BranchOverall;
  topic: Topic;
}) {
  const preview = (items: ReactNode[], empty: string, total?: number) => (
    <PreviewRows empty={empty} expanded={expanded} items={items} onToggle={onToggle} total={total} />
  );

  switch (topic) {
    case "residents": {
      const state = field(row, "residents");
      return <View className="gap-2">
        <FactRow label="Current residents" value={String(row.branch.residents)} />
        <Issue label="Resident list" state={state} />
        {state?.data ? preview(state.data.residents.map((person) =>
          <ListRow key={person.id} icon="person-outline" title={`${person.firstName} ${person.lastName}`.trim()}
            subtitle={[humanizeEnum(person.roomType), humanizeEnum(person.status)].filter(Boolean).join(" · ")}
            onPress={() => onOpen(`/manage/resident/${person.id}`)} />),
        "No resident records.", state.data.pagination?.total) : null}
      </View>;
    }
    case "wardens": {
      const state = field(row, "wardens");
      return <View className="gap-2">
        <Issue label="Wardens" state={state} />
        {state?.data ? <>
          <FactRow label="Wardens" value={String(state.data.pagination?.total ?? state.data.wardens.length)} />
          {preview(state.data.wardens.map((person) =>
            <ListRow key={person.id} icon="shield-outline" title={person.name}
              subtitle={[person.email, humanizeEnum(person.status)].filter(Boolean).join(" · ")}
              onPress={() => onOpen(TOPIC_ROUTES.wardens)} />), "No wardens yet.", state.data.pagination?.total)}
        </> : null}
      </View>;
    }
    case "cooks": {
      const state = field(row, "cooks");
      return <View className="gap-2">
        <Issue label="Cooks" state={state} />
        {state?.data ? <>
          <FactRow label="Active / invited / former" value={`${state.data.cooks.filter((person) => person.status === "ACTIVE").length} / ${state.data.cooks.filter((person) => person.status === "INVITED").length} / ${state.data.cooks.filter((person) => person.status === "REMOVED").length}`} />
          {preview(state.data.cooks.map((person) =>
            <ListRow key={person.id} icon="restaurant-outline" title={person.name}
              subtitle={[person.loginEmail, humanizeEnum(person.status)].filter(Boolean).join(" · ")}
              onPress={() => onOpen(TOPIC_ROUTES.cooks)} />), "No cooks yet.")}
        </> : null}
      </View>;
    }
    case "payments": {
      const invoices = field(row, "invoices");
      const periods = field(row, "periods");
      return <View className="gap-2">
        <Issue label="Payments" state={invoices} />
        {invoices?.data ? <>
          <FactRow label="Billed this month" value={formatMoney(invoices.data.totals.due)} />
          <FactRow label="Collected this month" value={formatMoney(invoices.data.totals.collected)} />
          <FactRow label="Still outstanding" value={formatMoney(Math.max(0, invoices.data.totals.due - invoices.data.totals.collected))} />
          <FactRow label="Unpaid / overdue residents" value={`${invoices.data.totals.unpaid} / ${invoices.data.totals.overdue}`} />
          {preview(invoices.data.rows.filter((item) => item.payment && item.payment.dueAmount > item.payment.paidAmount).map((item) =>
            <ListRow key={item.resident.id} icon="person-outline" title={item.resident.fullName}
              subtitle={`${formatMoney((item.payment?.dueAmount ?? 0) - (item.payment?.paidAmount ?? 0))} due · ${item.resident.roomNumber ?? item.resident.roomType ?? "Room not assigned"}`}
              onPress={() => onOpen(TOPIC_ROUTES.payments)} />), "No residents with an outstanding invoice.")}
        </> : null}
        <Issue label="Lifetime totals" state={periods} />
        {periods?.data ? <FactRow label="Collected since opening" value={formatMoney(periods.data.overall.collected)} /> : null}
      </View>;
    }
    case "statement": {
      const state = field(row, "ledger");
      return <View className="gap-2">
        <Issue label="Statement" state={state} />
        {state?.data ? <>
          <Text variant="caption">{state.data.entries.length} invoice entries loaded{state.data.truncated ? " · older entries omitted by server" : ""}. Expenses appear in the full statement.</Text>
          {preview(state.data.entries.map((entry) =>
            <ListRow key={entry.id} icon="receipt-outline" title={entry.residentName || "Resident payment"}
              subtitle={`${formatMoney(entry.paidAmount)} paid · ${humanizeEnum(entry.status)}`}
              onPress={() => onOpen(TOPIC_ROUTES.statement)} />), "No invoice entries yet.")}
        </> : null}
      </View>;
    }
    case "expenses": {
      const state = field(row, "expenses");
      return <View className="gap-2">
        <Issue label="Expenses" state={state} />
        {state?.data ? <>
          <FactRow label="Spent this month" value={state.data.totals ? formatMoney(state.data.totals.out) : "Unavailable"} />
          {preview(state.data.expenses.map((item) =>
            <ListRow key={item.id} icon="wallet-outline" title={item.what || item.categoryLabel}
              subtitle={`${formatMoney(item.amount)} · ${item.categoryLabel} · ${humanizeEnum(item.status)}`}
              onPress={() => onOpen(TOPIC_ROUTES.expenses)} />), "No expenses for this period.")}
        </> : null}
      </View>;
    }
    case "billing": {
      const state = field(row, "billing");
      return <View className="gap-2">
        <Issue label="Plan billing" state={state} />
        {state?.data ? <>
          <FactRow label="Plan" value={state.data.history.plan?.planName ?? "No active plan"} />
          <FactRow label="Status" value={humanizeEnum(state.data.history.plan?.status ?? "NOT_SET")} />
          <FactRow label="Open plan invoices" value={String(state.data.history.invoices.filter((item) => item.outstanding > 0).length)} />
        </> : null}
      </View>;
    }
    case "night": {
      const night = field(row, "night");
      const attendance = field(row, "attendanceToday");
      return <View className="gap-2">
        <Issue label="Night status" state={night} />
        {night?.data ? <>
          <FactRow label="Inside / outside" value={`${night.data.summary.INSIDE_HOSTEL} / ${night.data.summary.OUTSIDE_HOSTEL}`} />
          <FactRow label="Not verified / SOS" value={`${night.data.summary.NOT_VERIFIED} / ${night.data.summary.SOS_TRIGGERED}`} />
          {preview(night.data.statuses.filter((item) => item.status.status !== "INSIDE_HOSTEL").map((item) =>
            <ListRow key={item.resident.id} icon="moon-outline" title={item.resident.fullName}
              subtitle={humanizeEnum(item.status.status)} onPress={() => onOpen(TOPIC_ROUTES.night)} />),
          "Everyone in the loaded roster is inside.")}
          {night.data.pagination.hasMore ? <Text variant="caption">More residents are available in this branch’s night status.</Text> : null}
        </> : null}
        <Issue label="Today's attendance" state={attendance} />
        {attendance?.data ? <FactRow label="Outside today" value={String(attendance.data.summary.OUTSIDE ?? 0)} /> : null}
      </View>;
    }
    case "complaints": {
      const state = field(row, "complaints");
      return <View className="gap-2">
        <FactRow label="Open complaints" value={String(row.branch.openComplaints)} />
        <Issue label="Complaints" state={state} />
        {state?.data ? preview(state.data.complaints.map((item) =>
          <ListRow key={item.id} icon="chatbox-outline" title={item.title}
            subtitle={`${humanizeEnum(item.status)}${item.isOverdue ? " · Overdue" : ""}`}
            onPress={() => onOpen(TOPIC_ROUTES.complaints)} />),
        "No complaints.", state.data.pagination?.total) : null}
      </View>;
    }
    case "maintenance": {
      const state = field(row, "maintenance");
      return <View className="gap-2">
        <Issue label="Maintenance" state={state} />
        {state?.data ? <>
          <FactRow label="Open requests" value={String(state.data.summary.open)} />
          {preview(state.data.requests.map((item) =>
            <ListRow key={item.id} icon="construct-outline" title={item.title}
              subtitle={`${humanizeEnum(item.status)} · ${item.location}`}
              onPress={() => onOpen(TOPIC_ROUTES.maintenance)} />), "No maintenance requests.")}
        </> : null}
      </View>;
    }
    case "inquiries": {
      const state = field(row, "inquiries");
      return <View className="gap-2">
        <Issue label="Inquiries" state={state} />
        {state?.data ? <>
          <FactRow label="Inquiries" value={String(state.data.pagination?.total ?? state.data.inquiries.length)} />
          {preview(state.data.inquiries.map((item) =>
            <ListRow key={item.id} icon="mail-outline" title={item.name}
              subtitle={`${humanizeEnum(item.status)} · ${item.phone}`}
              onPress={() => onOpen(TOPIC_ROUTES.inquiries)} />), "No inquiries.", state.data.pagination?.total)}
        </> : null}
      </View>;
    }
    case "bookings": {
      const state = field(row, "bookings");
      return <View className="gap-2">
        <Issue label="Bookings" state={state} />
        {state?.data ? <>
          <FactRow label="Requests waiting" value={String(state.data.counts.requests)} />
          {preview(state.data.bookings.map((item) =>
            <ListRow key={item.id} icon="calendar-outline" title={item.guest.name}
              subtitle={`${item.roomType} · ${item.statusLabel}`}
              onPress={() => onOpen(TOPIC_ROUTES.bookings)} />), "No booking requests.")}
        </> : null}
      </View>;
    }
    case "notices": {
      const state = field(row, "notices");
      return <View className="gap-2">
        <Issue label="Notices" state={state} />
        {state?.data ? <>
          <FactRow label="Notices" value={String(state.data.pagination?.total ?? state.data.notices.length)} />
          {preview(state.data.notices.map((item) =>
            <ListRow key={item.id} icon="megaphone-outline" title={item.title}
              subtitle={humanizeEnum(item.category)} onPress={() => onOpen(TOPIC_ROUTES.notices)} />),
          "No notices.", state.data.pagination?.total)}
        </> : null}
      </View>;
    }
    case "performance": {
      const state = field(row, "performance");
      const report = state?.data?.report;
      return <View className="gap-2">
        <Issue label="Performance report" state={state} />
        {report ? <>
          <FactRow label="Billed / collected" value={`${formatMoney(report.finance.billed)} / ${formatMoney(report.finance.collected)}`} />
          <FactRow label="Outstanding" value={formatMoney(report.finance.outstanding)} />
          <FactRow label="Residents now" value={String(report.residents.now.total)} />
          <FactRow label="Moved in / out" value={`${report.residents.movedIn} / ${report.residents.movedOut}`} />
          <FactRow label="Open complaints / repairs" value={`${report.operations.complaints.open} / ${report.operations.repairs.open}`} />
          <FactRow label="Listing views" value={String(report.listing.views.current)} />
        </> : null}
      </View>;
    }
    case "food": {
      const state = field(row, "food");
      return <View className="gap-2">
        <Issue label="Food report" state={state} />
        {state?.data ? <>
          <FactRow label="Report window" value={`${state.data.summary.windowDays} days`} />
          <FactRow label="Meals announced" value={String(state.data.summary.totalAnnouncements)} />
          <FactRow label="Late announcements" value={String(state.data.summary.lateAnnouncements)} />
        </> : null}
      </View>;
    }
    case "attendance": {
      const state = field(row, "attendance");
      return <View className="gap-2">
        <Issue label="Attendance report" state={state} />
        {state?.data ? <>
          <FactRow label="Report window" value={`${state.data.summary.windowDays} days`} />
          <FactRow label="Residents tracked" value={String(state.data.summary.residentsTracked)} />
          <FactRow label="Average attendance" value={`${Math.round(state.data.summary.averageAttendanceRate * 100)}%`} />
        </> : null}
      </View>;
    }
  }
}

export default function OverallScreen() {
  const role = useAppSelector((state) => state.auth.account?.role);
  if (role !== ROLE.HOSTEL_ADMIN) {
    return <Screen header={<AppBar showBack title="Overall" />}><ErrorState message="Only the hostel owner can view all branches." /></Screen>;
  }
  return <OwnerOverallScreen />;
}

function OwnerOverallScreen() {
  const { colors } = useAppTheme();
  const [section, setSection] = useState<OverallSection>("overview");
  const [topic, setTopic] = useState<Topic>("residents");
  const [expandedBranchId, setExpandedBranchId] = useState<string | null>(null);
  const [pagesFor, setPagesFor] = useState<BranchOverall | null>(null);
  const period = nepalPeriodKey();
  const load = useCallback(() => getOverallData(section, period), [section, period]);
  const resource = useResource<OverallData>(load, { cacheKey: `admin:overall:${section}:${period}` });

  // useResource can retain the previous query during a section switch. Never
  // label its old rows with the newly selected topic while the new read loads.
  const visible = resource.data?.section === section ? resource.data : null;
  const rows = useMemo(() => visible?.branches ?? [], [visible]);
  const options = TOPICS[section];
  const selectedTopic = options.some((option) => option.value === topic) ? topic : options[0]?.value;

  const open = useCallback((row: BranchOverall, route: string) => {
    const main = rows.find((item) => !item.branch.isBranch)?.branch.id;
    void setActiveHostelId(row.branch.id === main ? null : row.branch.id)
      .then(() => router.replace(route as never));
  }, [rows]);

  const changeSection = (next: OverallSection) => {
    setSection(next);
    setTopic(TOPICS[next][0]?.value ?? "residents");
    setExpandedBranchId(null);
    setPagesFor(null);
  };

  return <>
    <Screen header={<AppBar accent showBack title="Overall" actions={<HostelSwitcher compact />} />}
      scroll onRefresh={resource.refresh} refreshing={resource.refreshing}>
      <View className="gap-5 pt-1">
        <View className="gap-1">
          <Text variant="title">All hostels</Text>
          <Text variant="caption">Read-only overview. Open a hostel to work in its records.</Text>
        </View>
        <Segmented options={SECTIONS} value={section} onChange={changeSection} />
        {section !== "overview" && selectedTopic ? (
          <TopicPicker key={section} options={options} value={selectedTopic}
            onChange={(next) => { setTopic(next); setExpandedBranchId(null); }} />
        ) : null}
        {!visible && !resource.error ? <SkeletonCard rows={4} /> : null}
        {resource.error ? <ErrorState message={resource.error} onRetry={resource.reload} /> : null}
        {visible ? (
          rows.length === 0 ? <Card><Text variant="caption">No hostels are available for this account.</Text></Card>
          : section === "overview" ? (
            <SummaryView onOpen={open} onPages={setPagesFor} period={visible.period} rows={rows} />
          ) : selectedTopic === "billing" ? (
            <View className="gap-3">
              <Text variant="caption">One plan covers the main hostel and its branches. Billing is shown once here.</Text>
              {rows.filter((row) => !row.branch.isBranch).map((row) => (
                <BranchCard key={row.branch.id} row={row}>
                  <TopicBody expanded={false} onOpen={(route) => open(row, route)}
                    onToggle={() => {}} row={row} topic="billing" />
                  <ListRow icon="card-outline" title="Open plan billing" onPress={() => open(row, TOPIC_ROUTES.billing)} />
                </BranchCard>
              ))}
            </View>
          ) : selectedTopic ? (
            <View className="gap-4">
              <View>
                <SectionHeader title={options.find((option) => option.value === selectedTopic)?.label ?? ""}
                  subtitle={`${visible.period} · ${rows.length} hostels`} />
                {selectedTopic === "statement" ? (
                  <Text variant="caption">Statements stay separate by hostel. Open one to see its full invoice and expense history.</Text>
                ) : null}
                <TopicTotal rows={rows} topic={selectedTopic} />
              </View>
              {rows.map((row) => (
                <BranchCard key={row.branch.id} row={row}>
                  <View className="gap-2">
                    <TopicBody expanded={expandedBranchId === row.branch.id}
                      onOpen={(route) => open(row, route)}
                      onToggle={() => setExpandedBranchId((current) => current === row.branch.id ? null : row.branch.id)}
                      row={row} topic={selectedTopic} />
                    <View className="border-t border-border pt-1">
                      <ListRow icon="arrow-forward-outline"
                        title={`Open full ${options.find((option) => option.value === selectedTopic)?.label.toLowerCase() ?? "screen"}`}
                        subtitle={row.branch.name}
                        onPress={() => open(row, TOPIC_ROUTES[selectedTopic])} />
                    </View>
                  </View>
                </BranchCard>
              ))}
            </View>
          ) : null
        ) : null}
      </View>
    </Screen>
    <Sheet bare fitContent open={Boolean(pagesFor)} onClose={() => setPagesFor(null)}
      title={pagesFor ? `${pagesFor.branch.name} screens` : "Branch screens"}>
      <View className="gap-2 py-3">
        {BRANCH_PAGES.map((group) => <View key={group.group} className="gap-1">
          <Text className="px-5 pt-2" variant="label">{group.group}</Text>
          {group.pages.map((page) => <SheetRow key={page.route} label={page.title}
            leading={<Ionicons color={colors.primary} name="arrow-forward-circle-outline" size={20} />}
            onPress={() => {
              const target = pagesFor;
              setPagesFor(null);
              if (target) open(target, page.route);
            }}
            trailing={<Ionicons color={colors.mutedForeground} name="chevron-forward" size={16} />} />)}
        </View>)}
      </View>
    </Sheet>
  </>;
}
