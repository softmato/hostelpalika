import { View } from "react-native";

import { NightStrip } from "@/components/portal-shared";
import {
  AdminHomeHeader,
  EarningsTrend,
  HostelHero,
  QuickActions,
} from "@/components/admin-home";
import { Badge } from "@/components/ui/badge";
import { Card, SectionHeader, SectionLink } from "@/components/ui/card";
import { DataCard } from "@/components/ui/data-card";
import { Grid, InfoTile } from "@/components/ui/layout";
import { Screen } from "@/components/ui/screen";
import type { AdminHostel, AdminPeriodRow } from "@/lib/admin-api";
import {
  collectionRate,
  earningsSummary,
  earningsTrend,
  listingState,
  monthOverMonth,
  nightChips,
} from "@/lib/admin-home";
import { formatMoney } from "@/lib/format";

const HOSTEL: AdminHostel = {
  capacitySummary: { totalBeds: 48, totalRooms: 16, vacantBeds: 6 },
  contact: { email: "office@shantibhawan.com.np", phone: "9801234567" },
  hostelType: "CO_LIVING",
  id: "h1",
  location: { address: "Ward 10", area: "Ghattekulo", city: "Kathmandu" },
  name: "Shanti Bhawan Residency",
  photos: [],
  slug: "shanti-bhawan",
  status: "PUBLISHED",
  verificationStatus: "VERIFIED",
};

function month(period: string, collected: number, due: number): AdminPeriodRow {
  return { collected, due, needsAttention: 0, paid: 0, period, total: 0 };
}

const MONTHS = [
  month("2026-08", 74000, 98000),
  month("2026-07", 96000, 98000),
  month("2026-06", 88000, 92000),
  month("2026-05", 91000, 92000),
  month("2026-04", 62000, 86000),
  month("2026-03", 84000, 86000),
];

export default function UiPreview() {
  const earnings = earningsSummary({
    months: MONTHS,
    overall: { collected: 1284000, outstanding: 146000 },
    report: { monthlyDues: 98000, paidAmount: 74000 },
  });
  const chips = nightChips({
    INSIDE_HOSTEL: 34,
    NOT_VERIFIED: 5,
    OUTSIDE_HOSTEL: 2,
    SOS_TRIGGERED: 1,
  });

  return (
    <Screen
      // The gallery shows the bar as a live listing gets it — both actions on.
      header={<AdminHomeHeader onPreview={() => {}} />}
      insideTabs={false}
      padded={false}
      scroll
    >
      <HostelHero
        delta={monthOverMonth(MONTHS)}
        earnings={earnings}
        hostel={HOSTEL}
        listing={listingState(HOSTEL)}
        occupancy={88}
        onSos={() => {}}
        residents={42}
        sosCount={1}
        vacantBeds={6}
      />

      <QuickActions
        onNewResident={() => {}}
        onRollCall={() => {}}
        onScan={() => {}}
        onStore={() => {}}
      />

      <View className="gap-6 px-5 pt-6">
        <View>
          <SectionHeader
            action={<SectionLink onPress={() => {}} />}
            title="Waiting for you"
          />
          <Grid maxColumns={2} minCellWidth={140}>
            {/* No badge: importing a statement is something you do, not a
                queue. `Payments to check` and `Post notice` both left this row
                — Money is a tab and notices are a Manage tile — see
                `WaitingActions`. */}
            <InfoTile
              icon="document-text"
              label="Statement"
              onPress={() => {}}
              tone="warning"
            />
            <InfoTile
              badge={2}
              icon="mail"
              label="New inquiries"
              onPress={() => {}}
              tone="brand"
            />
            <InfoTile
              icon="today"
              label="Today"
              onPress={() => {}}
              tone="success"
            />
          </Grid>
        </View>

        <View>
          <SectionHeader
            action={<Badge label="Chasing" tone="warning" />}
            title="Money"
          />
          <View className="gap-3">
            <DataCard
              footer={{
                left: `${collectionRate(earnings.thisMonth, earnings.thisMonthBilled)}% of this month's bills are paid`,
                right: `${formatMoney(earnings.outstanding)} due, all time`,
              }}
              meta="Collected against what was billed"
              onPress={() => {}}
              segments={[
                {
                  label: `Collected ${formatMoney(earnings.thisMonth)}`,
                  tone: "brand",
                  value: earnings.thisMonth,
                },
              ]}
              stats={[
                { label: "Collected", value: formatMoney(earnings.thisMonth) },
                { label: "Billed", value: formatMoney(earnings.thisMonthBilled) },
                {
                  label: "Still due",
                  value: formatMoney(
                    Math.max(0, earnings.thisMonthBilled - earnings.thisMonth),
                  ),
                },
              ]}
              title="This month"
              total={earnings.thisMonthBilled}
            />

            <Card>
              <EarningsTrend bars={earningsTrend(MONTHS)} />
            </Card>

            <DataCard
              meta="Across every month, not just this one"
              onPress={() => {}}
              stats={[
                { label: "Residents overdue", value: "4" },
                { label: "Proofs waiting", value: "3" },
              ]}
              title="Still chasing"
            />
          </View>
        </View>

        <View>
          <SectionHeader title="Tonight" />
          <Card>
            <NightStrip chips={chips} />
          </Card>
        </View>

        <DataCard
          action={<Badge label="Live on the site" tone="success" />}
          meta="How the public listing is doing"
          stats={[
            { label: "Views · 30d", value: "1,284" },
            { label: "Visitors", value: "903" },
            { label: "All time", value: "7,412" },
          ]}
          title="Your listing"
        />
      </View>
    </Screen>
  );
}
