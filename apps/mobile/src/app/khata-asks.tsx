import { View } from "react-native";

import { KhataAsks } from "@/components/khata-asks";
import { AppBar } from "@/components/ui/app-bar";
import { Screen } from "@/components/ui/screen";
import { SkeletonRows } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { useResource } from "@/hooks/use-resource";
import { khataQuery } from "@/lib/khata-api";

/** The kitchen's khata asks — tap one, Give or Not available. */
export default function KhataAsksScreen() {
  const query = khataQuery.orders();
  const orders = useResource(query.load, { cacheKey: query.key, topics: query.topics });

  const header = <AppBar accent centerTitle showBack title="Khata asks" />;

  if (orders.loading) {
    return (
      <Screen header={header}>
        <SkeletonRows rows={4} />
      </Screen>
    );
  }

  if (orders.error || !orders.data) {
    return (
      <Screen header={header}>
        <ErrorState message={orders.error ?? "Could not load"} onRetry={orders.reload} />
      </Screen>
    );
  }

  return (
    <Screen header={header} onRefresh={orders.refresh} refreshing={orders.refreshing} scroll>
      <View className="pt-1">
        <KhataAsks onChanged={orders.refresh} orders={orders.data} />
      </View>
    </Screen>
  );
}
