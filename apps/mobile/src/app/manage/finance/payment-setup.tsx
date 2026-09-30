import { View } from "react-native";

import {
  PaymentDestinations,
  PaymentQrCard,
  PaymentSheet,
  PaymentStatusCard,
  usePaymentSetup,
} from "@/components/manage/payment-setup";
import { AppBar } from "@/components/ui/app-bar";
import { Card, SectionHeader } from "@/components/ui/card";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { SkeletonCard } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { formatMoney } from "@/lib/format";

/**
 * Payment setup — where residents are asked to send money.
 *
 * A summary, like Finance: a setup score, the QR, and one row per destination
 * or rule. Each row opens a small sheet that saves only its own fields, so a
 * warden changing the eSewa ID never scrolls past the bank form to do it. The
 * pieces live in `components/manage/payment-setup`, which Hostel KYC also draws.
 */
export default function ManagePaymentSetupScreen() {
  const setup = usePaymentSetup();
  const { openSection, profile, resource } = setup;

  const header = <AppBar accent centerTitle showBack title="Payment setup" />;

  if (resource.loading) {
    return (
      <Screen header={header}>
        <View className="gap-4 pt-1">
          <SkeletonCard rows={2} />
          <SkeletonCard rows={4} />
        </View>
      </Screen>
    );
  }

  if (resource.error || !profile) {
    return (
      <Screen header={header}>
        <ErrorState message={resource.error ?? "No payment setup"} onRetry={resource.reload} />
      </Screen>
    );
  }

  return (
    <Screen header={header} onRefresh={resource.refresh} refreshing={resource.refreshing} scroll>
      <View className="gap-5 pt-1">
        <PaymentStatusCard profile={profile} />
        <PaymentQrCard setup={setup} />
        <PaymentDestinations setup={setup} />

        <View>
          <SectionHeader title="Settings" />
          <Card padding="px-4 py-1">
            <ListRow
              icon="storefront-outline"
              iconBgColor="#007AFF"
              onPress={() => openSection("name")}
              subtitle={profile.displayName || "Not set"}
              title="Name residents see"
            />
            <RowDivider inset />
            <ListRow
              icon="cash-outline"
              iconBgColor="#34C759"
              onPress={() => openSection("cash")}
              subtitle={
                profile.cashApprovalThreshold > 0
                  ? `Second approver above ${formatMoney(profile.cashApprovalThreshold)}`
                  : "Every cash entry needs a second approver"
              }
              title="Cash approval"
            />
            <RowDivider inset />
            <ListRow
              icon="calendar-outline"
              iconBgColor="#FF9500"
              onPress={() => openSection("cadence")}
              subtitle={`Every ${profile.statementCadenceDays} days`}
              title="Statement reminder"
            />
            <RowDivider inset />
            <ListRow
              icon="chatbubble-ellipses-outline"
              iconBgColor="#AF52DE"
              onPress={() => openSection("note")}
              subtitle={profile.paymentInstructions || "None"}
              title="Note for residents"
            />
          </Card>
        </View>

        <Text className="text-center" variant="caption">
          Booking payouts are under Bookings → Settings.
        </Text>
      </View>

      <PaymentSheet setup={setup} />
    </Screen>
  );
}
