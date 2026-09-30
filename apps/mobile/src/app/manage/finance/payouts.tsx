import { View } from "react-native";

import { PayoutAccountCard } from "@/components/manage/payout-account-card";
import { AppBar } from "@/components/ui/app-bar";
import { Screen } from "@/components/ui/screen";

/**
 * Booking payouts, from Finance → Getting paid. The same card Bookings shows —
 * where the platform sends this hostel's share when someone books a bed.
 */
export default function FinancePayoutsScreen() {
  return (
    <Screen header={<AppBar accent centerTitle showBack title="Booking payouts" />} scroll>
      <View className="pt-1">
        <PayoutAccountCard />
      </View>
    </Screen>
  );
}
