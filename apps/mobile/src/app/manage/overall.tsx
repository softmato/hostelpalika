import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
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
  { label: "Operations", value: "operations" },
  { label: "Reports", value: "reports" },
];

const ROUTES: Record<OverallSection, string> = {
  overview: "/(admin)",
  people: "/(admin)/residents",
  money: "/(admin)/money",
  operations: "/(admin)/today",
  reports: "/manage/reports",
};

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
    <Text className="text-warning" variant="caption">{label}: {state.error}</Text>
  ) : null;
}

function group(title: string, children: ReactNode) {
  return <View className="gap-2"><Text variant="label">{title}</Text>{children}</View>;
}

function BranchSummary({ row, open }: { row: BranchOverall; open: (route: string) => void }) {
  const { branch } = row;
  const profile = field(row, "profile");
  return (
    <View className="gap-2">
      <FactRow label="Residents" value={String(branch.residents)} />
      <FactRow label="Beds" value={`${branch.beds} · ${branch.occupancyPercent ?? 0}% occupied`} />
      <FactRow label="Collected this month" value={formatMoney(branch.collected)} />
      <FactRow label="Still due this month" value={formatMoney(branch.due)} />
      <FactRow label="Open complaints" value={String(branch.openComplaints)} />
      <Issue label="Rooms and rates" state={profile} />
      {profile?.data ? <>
        <FactRow label="Vacant beds" value={String(profile.data.hostel.capacitySummary.vacantBeds ?? 0)} />
        <FactRow label="Room types" value={String(profile.data.hostel.roomConfigurations.length)} />
        {profile.data.hostel.roomConfigurations.map((room) => <ListRow key={room.roomType} icon="bed-outline"
          title={humanizeEnum(room.roomType)}
          subtitle={`${room.rooms} rooms · ${room.vacantBeds} beds open · ${room.monthlyRent == null ? "Rate not set" : `${formatMoney(room.monthlyRent)} monthly`}`}
          onPress={() => open("/manage/rooms")} />)}
      </> : null}
    </View>
  );
}

function People({ row, open }: { row: BranchOverall; open: (route: string) => void }) {
  const residents = field(row, "residents");
  const wardens = field(row, "wardens");
  const cooks = field(row, "cooks");
  return (
    <View className="gap-4">
      {group("Residents", <>
        <Issue label="Residents" state={residents} />
        {residents?.data ? <>
          <Text variant="caption">{residents.data.pagination?.total ?? residents.data.residents.length} records · showing {Math.min(12, residents.data.residents.length)} here</Text>
          {residents.data.residents.slice(0, 12).map((person) => (
            <ListRow key={person.id} icon="person-outline" title={`${person.firstName} ${person.lastName}`.trim()}
              subtitle={[person.roomType && humanizeEnum(person.roomType), person.phone, humanizeEnum(person.status)].filter(Boolean).join(" · ")}
              onPress={() => open(`/manage/resident/${person.id}`)} />
          ))}
          {residents.data.residents.length > 12 || residents.data.pagination?.hasMore ? <ListRow title="Open branch resident roster" icon="people-outline" onPress={() => open("/(admin)/residents")} /> : null}
        </> : null}
      </>)}
      {group("Wardens", <>
        <Issue label="Wardens" state={wardens} />
        {wardens?.data ? <>
          <Text variant="caption">{wardens.data.pagination?.total ?? wardens.data.wardens.length} records</Text>
          {wardens.data.wardens.slice(0, 8).map((person) => <ListRow key={person.id} icon="shield-outline" title={person.name} subtitle={[person.email, humanizeEnum(person.status)].join(" · ")} onPress={() => open("/manage/wardens")} />)}
          {wardens.data.wardens.length === 0 ? <Text variant="caption">No wardens yet.</Text> : null}
          {wardens.data.wardens.length > 8 || wardens.data.pagination?.hasMore ? <ListRow title="Open branch wardens" icon="arrow-forward-outline" onPress={() => open("/manage/wardens")} /> : null}
        </> : null}
      </>)}
      {group("Cooks", <>
        <Issue label="Cooks" state={cooks} />
        {cooks?.data ? <>
          <Text variant="caption">{cooks.data.cooks.filter((cook) => cook.status !== "REMOVED").length} current · {cooks.data.cooks.filter((cook) => cook.status === "REMOVED").length} former</Text>
          {cooks.data.cooks.slice(0, 8).map((person) => <ListRow key={person.id} icon="restaurant-outline" title={person.name} subtitle={[person.loginEmail, humanizeEnum(person.status)].filter(Boolean).join(" · ")} onPress={() => open("/manage/cook")} />)}
          {cooks.data.cooks.length === 0 ? <Text variant="caption">No cooks yet.</Text> : null}
          {cooks.data.cooks.length > 8 ? <ListRow title="See all cooks" icon="arrow-forward-outline" onPress={() => open("/manage/cook")} /> : null}
        </> : null}
      </>)}
    </View>
  );
}

function MoneySection({ row, open }: { row: BranchOverall; open: (route: string) => void }) {
  const invoices = field(row, "invoices");
  const periods = field(row, "periods");
  const ledger = field(row, "ledger");
  const expenses = field(row, "expenses");
  const billing = field(row, "billing");
  return <View className="gap-4">
    {group("Resident payments", <>
      <Issue label="Payments" state={invoices} />
      {invoices?.data ? <>
        <FactRow label="Billed this month" value={formatMoney(invoices.data.totals.due)} />
        <FactRow label="Collected this month" value={formatMoney(invoices.data.totals.collected)} />
        <FactRow label="Unpaid / overdue" value={`${invoices.data.totals.unpaid} / ${invoices.data.totals.overdue}`} />
        {invoices.data.rows.filter((item) => item.payment && item.payment.dueAmount > item.payment.paidAmount).slice(0, 5).map((item) =>
          <ListRow key={item.resident.id} icon="person-outline" title={item.resident.fullName} subtitle={`${formatMoney((item.payment?.dueAmount ?? 0) - (item.payment?.paidAmount ?? 0))} due · ${item.resident.roomNumber ?? item.resident.roomType ?? "Room not assigned"}`} onPress={() => open("/(admin)/money")} />)}
      </> : null}
      <Issue label="Lifetime totals" state={periods} />
      {periods?.data ? <FactRow label="Collected since opening" value={formatMoney(periods.data.overall.collected)} /> : null}
    </>)}
    {group("Statement", <>
      <Issue label="Statement" state={ledger} />
      {ledger?.data ? <>
        <Text variant="caption">{ledger.data.entries.length} invoice entries{ledger.data.truncated ? " · older entries omitted by server" : ""}</Text>
        {ledger.data.entries.slice(0, 4).map((entry) => <ListRow key={entry.id} icon="receipt-outline" title={entry.residentName || "Resident payment"} subtitle={`${formatMoney(entry.paidAmount)} paid · ${humanizeEnum(entry.status)}`} onPress={() => open("/manage/finance/statement")} />)}
        <ListRow title="Open full statement" icon="arrow-forward-outline" onPress={() => open("/manage/finance/statement")} />
      </> : null}
    </>)}
    {group("Expenses", <>
      <Issue label="Expenses" state={expenses} />
      {expenses?.data ? <>
        <FactRow label="Spent this month" value={expenses.data.totals ? formatMoney(expenses.data.totals.out) : "Unavailable"} />
        {expenses.data.expenses.slice(0, 4).map((item) => <ListRow key={item.id} icon="wallet-outline" title={item.what || item.categoryLabel} subtitle={`${formatMoney(item.amount)} · ${item.categoryLabel}`} onPress={() => open("/expenses")} />)}
      </> : null}
    </>)}
    {group(row.branch.isBranch ? "Platform billing · shared with main hostel" : "Platform billing", <>
      <Issue label="Plan billing" state={billing} />
      {billing?.data ? <>
        <FactRow label="Plan" value={billing.data.history.plan?.planName ?? "No active plan"} />
        <FactRow label="Plan status" value={humanizeEnum(billing.data.history.plan?.status ?? "NOT_SET")} />
        <FactRow label="Open plan invoices" value={String(billing.data.history.invoices.filter((item) => item.outstanding > 0).length)} />
        <ListRow title="Open plan billing" icon="card-outline" onPress={() => open("/manage/billing")} />
      </> : null}
    </>)}
  </View>;
}

function Operations({ row, open }: { row: BranchOverall; open: (route: string) => void }) {
  const complaints = field(row, "complaints");
  const maintenance = field(row, "maintenance");
  const inquiries = field(row, "inquiries");
  const night = field(row, "night");
  const attendance = field(row, "attendanceToday");
  const bookings = field(row, "bookings");
  const notices = field(row, "notices");
  return <View className="gap-4">
    {group("Tonight and attendance", <>
      <Issue label="Night status" state={night} />
      {night?.data ? <>
        <FactRow label="Inside / outside" value={`${night.data.summary.INSIDE_HOSTEL} / ${night.data.summary.OUTSIDE_HOSTEL}`} />
        <FactRow label="Not verified / SOS" value={`${night.data.summary.NOT_VERIFIED} / ${night.data.summary.SOS_TRIGGERED}`} />
        <ListRow title="Open night status" icon="moon-outline" onPress={() => open("/manage/roll-call")} />
      </> : null}
      <Issue label="Attendance" state={attendance} />
      {attendance?.data ? <FactRow label="Outside today" value={String(attendance.data.summary.OUTSIDE ?? 0)} /> : null}
    </>)}
    {group("Complaints", <><Issue label="Complaints" state={complaints} />
      {complaints?.data ? <><Text variant="caption">{complaints.data.pagination?.total ?? complaints.data.complaints.length} records</Text>
        {complaints.data.complaints.slice(0, 5).map((item) => <ListRow key={item.id} icon="chatbox-outline" title={item.title} subtitle={humanizeEnum(item.status)} onPress={() => open("/manage/complaints")} />)}
      </> : null}</>)}
    {group("Maintenance", <><Issue label="Maintenance" state={maintenance} />
      {maintenance?.data ? <><FactRow label="Open requests" value={String(maintenance.data.summary.open)} />
        {maintenance.data.requests.slice(0, 5).map((item) => <ListRow key={item.id} icon="construct-outline" title={item.title} subtitle={`${humanizeEnum(item.status)} · ${item.location}`} onPress={() => open("/manage/maintenance")} />)}
      </> : null}</>)}
    {group("Inquiries", <><Issue label="Inquiries" state={inquiries} />
      {inquiries?.data ? <><Text variant="caption">{inquiries.data.pagination?.total ?? inquiries.data.inquiries.length} records</Text>
        {inquiries.data.inquiries.slice(0, 5).map((item) => <ListRow key={item.id} icon="mail-outline" title={item.name} subtitle={`${humanizeEnum(item.status)} · ${item.phone}`} onPress={() => open("/manage/inquiries")} />)}
      </> : null}</>)}
    {group("Bookings", <><Issue label="Bookings" state={bookings} />
      {bookings?.data ? <>
        <FactRow label="Requests waiting" value={String(bookings.data.counts.requests)} />
        {bookings.data.bookings.slice(0, 4).map((item) => <ListRow key={item.id} icon="calendar-outline" title={item.guest.name} subtitle={`${item.roomType} · ${item.statusLabel}`} onPress={() => open("/manage/bookings")} />)}
      </> : null}</>)}
    {group("Notices", <><Issue label="Notices" state={notices} />
      {notices?.data ? <>
        <Text variant="caption">{notices.data.pagination?.total ?? notices.data.notices.length} notices</Text>
        {notices.data.notices.slice(0, 4).map((item) => <ListRow key={item.id} icon="megaphone-outline" title={item.title} subtitle={humanizeEnum(item.category)} onPress={() => open("/manage/notices")} />)}
      </> : null}</>)}
  </View>;
}

function Reports({ row, open }: { row: BranchOverall; open: (route: string) => void }) {
  const performance = field(row, "performance");
  const food = field(row, "food");
  const attendance = field(row, "attendance");
  const report = performance?.data?.report;
  return <View className="gap-4">
    {group("Monthly performance", <><Issue label="Performance report" state={performance} />
      {report ? <>
        <FactRow label="Billed" value={formatMoney(report.finance.billed)} />
        <FactRow label="Collected" value={formatMoney(report.finance.collected)} />
        <FactRow label="Outstanding" value={formatMoney(report.finance.outstanding)} />
        <FactRow label="Residents now" value={String(report.residents.now.total)} />
        <FactRow label="Moved in / out" value={`${report.residents.movedIn} / ${report.residents.movedOut}`} />
        <FactRow label="Open complaints / repairs" value={`${report.operations.complaints.open} / ${report.operations.repairs.open}`} />
        <FactRow label="Listing views" value={String(report.listing.views.current)} />
      </> : null}</>)}
    {group("Food report", <><Issue label="Food report" state={food} />
      {food?.data ? <><FactRow label="Meals announced" value={String(food.data.summary.totalAnnouncements)} />
        <FactRow label="Late announcements" value={String(food.data.summary.lateAnnouncements)} /></> : null}</>)}
    {group("Attendance report", <><Issue label="Attendance report" state={attendance} />
      {attendance?.data ? <><FactRow label="Residents tracked" value={String(attendance.data.summary.residentsTracked)} />
        <FactRow label="Average attendance" value={`${Math.round(attendance.data.summary.averageAttendanceRate)}%`} /></> : null}</>)}
    <ListRow title="Open detailed reports and exports" icon="bar-chart-outline" onPress={() => open("/manage/reports")} />
  </View>;
}

export default function OverallScreen() {
  const role = useAppSelector((state) => state.auth.account?.role);
  if (role !== ROLE.HOSTEL_ADMIN) return <Screen header={<AppBar showBack title="Overall" />}><ErrorState message="Only the hostel owner can view all branches." /></Screen>;
  return <OwnerOverallScreen />;
}

function OwnerOverallScreen() {
  const { colors } = useAppTheme();
  const [section, setSection] = useState<OverallSection>("overview");
  const [pagesFor, setPagesFor] = useState<BranchOverall | null>(null);
  const period = nepalPeriodKey();
  const load = useCallback(() => getOverallData(section, period), [section, period]);
  const data = useResource<OverallData>(load, { cacheKey: `admin:overall:${section}:${period}` });
  const rows = useMemo(() => data.data?.branches ?? [], [data.data]);
  const total = useMemo(() => rows.reduce((sum, row) => ({
    beds: sum.beds + row.branch.beds,
    collected: sum.collected + row.branch.collected,
    complaints: sum.complaints + row.branch.openComplaints,
    due: sum.due + row.branch.due,
    residents: sum.residents + row.branch.residents,
  }), { beds: 0, collected: 0, complaints: 0, due: 0, residents: 0 }), [rows]);

  const open = useCallback((row: BranchOverall, route: string) => {
    const main = rows.find((item) => !item.branch.isBranch)?.branch.id;
    void setActiveHostelId(row.branch.id === main ? null : row.branch.id)
      .then(() => router.replace(route as never));
  }, [rows]);

  return <>
    <Screen header={<AppBar accent centerTitle showBack title="Overall" />} scroll onRefresh={data.refresh} refreshing={data.refreshing}>
      <View className="gap-5 pt-1">
        <View className="gap-2">
          <Text variant="title">All your hostels</Text>
          <Text variant="caption">A read-only view across branches. Every section keeps each hostel separate; open a branch to make changes.</Text>
        </View>
        <Segmented options={SECTIONS} value={section} onChange={setSection} />
        {data.loading && !data.data ? <SkeletonCard rows={5} /> : null}
        {data.error ? <ErrorState message={data.error} onRetry={data.reload} /> : null}
        {data.data ? <>
          <Card className="gap-2 bg-brand-soft">
            <Text variant="label">{rows.length} hostels together · {data.data.period}</Text>
            <FactRow label="Residents / beds" value={`${total.residents} / ${total.beds}`} />
            <FactRow label="Collected / due this month" value={`${formatMoney(total.collected)} / ${formatMoney(total.due)}`} />
            <FactRow label="Open complaints" value={String(total.complaints)} />
          </Card>
          {rows.map((row) => <View className="gap-2" key={row.branch.id}>
            <SectionHeader title={row.branch.name} subtitle={[row.branch.area, row.branch.city].filter(Boolean).join(", ") || row.branch.slug} />
            <Card className="gap-4">
              <View className="flex-row items-center justify-between">
                <Badge label={row.branch.isBranch ? "Branch" : "Main hostel"} tone="info" />
                <Text variant="caption">{humanizeEnum(row.branch.status)}</Text>
              </View>
              {section === "overview" ? <BranchSummary row={row} open={(route) => open(row, route)} /> : null}
              {section === "people" ? <People row={row} open={(route) => open(row, route)} /> : null}
              {section === "money" ? <MoneySection row={row} open={(route) => open(row, route)} /> : null}
              {section === "operations" ? <Operations row={row} open={(route) => open(row, route)} /> : null}
              {section === "reports" ? <Reports row={row} open={(route) => open(row, route)} /> : null}
              <View className="border-t border-border pt-2">
                <ListRow icon="business-outline" title={`Open ${row.branch.name}`} subtitle="Work in this branch" onPress={() => open(row, ROUTES[section])} />
                <ListRow icon="grid-outline" title="All branch screens" subtitle="Rooms, billing, staff, reports and more" onPress={() => setPagesFor(row)} />
              </View>
            </Card>
          </View>)}
          {rows.length === 0 ? <Card><Text variant="caption">No hostels are available for this account.</Text></Card> : null}
        </> : null}
      </View>
    </Screen>
    <Sheet bare fitContent open={Boolean(pagesFor)} onClose={() => setPagesFor(null)} title={pagesFor?.branch.name ?? "Branch screens"}>
      <View className="gap-2 px-4 py-3">
        {BRANCH_PAGES.map((group) => <View key={group.group} className="gap-1">
          <Text className="px-4 pt-2" variant="label">{group.group}</Text>
          {group.pages.map((page) => <SheetRow key={page.route} label={page.title}
            leading={<Ionicons color={colors.primary} name="arrow-forward-circle-outline" size={20} />}
            onPress={() => { const target = pagesFor; setPagesFor(null); if (target) open(target, page.route); }}
            trailing={<Ionicons color={colors.mutedForeground} name="chevron-forward" size={16} />} />)}
        </View>)}
      </View>
    </Sheet>
  </>;
}
