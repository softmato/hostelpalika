import { Image } from "expo-image";
import { router } from "expo-router";
import type { ReactNode } from "react";
import { View } from "react-native";

import { useBranchesLock } from "@/components/hostel-switcher";
import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Glyph } from "@/components/ui/glyph";
import { ListRow } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { SkeletonCard } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { setActiveHostelId } from "@/lib/active-hostel";
import { getBranches } from "@/lib/admin-api";
import { API_BASE_URL } from "@/lib/api";
import { absoluteMediaUrl } from "@/lib/media";

const STATUS: Record<
  string,
  { label: string; tone: "neutral" | "success" | "warning" | "danger" }
> = {
  PENDING_APPROVAL: { label: "Waiting for our call", tone: "warning" },
  PUBLISHED: { label: "Live", tone: "success" },
  REJECTED: { label: "Not approved", tone: "danger" },
};

/** Max only, owner only (`useBranchesLock`) — says so instead of fetching a 403. */
export default function BranchesScreen() {
  const lock = useBranchesLock();
  const header = <AppBar accent centerTitle showBack title="Branches" />;

  if (lock) {
    return (
      <Screen header={header}>
        <EmptyState icon="lock-closed-outline" title={lock} tone="warning" />
      </Screen>
    );
  }

  if (lock === undefined) {
    return (
      <Screen header={header}>
        <View className="gap-4 pt-1">
          <SkeletonCard rows={3} />
        </View>
      </Screen>
    );
  }

  return <BranchList header={header} />;
}

function BranchList({ header }: { header: ReactNode }) {
  const { colors } = useAppTheme();
  const branches = useResource(getBranches, { cacheKey: "admin:branch-list" });

  if (branches.loading) {
    return (
      <Screen header={header}>
        <View className="gap-4 pt-1">
          <SkeletonCard rows={3} />
        </View>
      </Screen>
    );
  }

  if (branches.error || !branches.data) {
    return (
      <Screen header={header}>
        <ErrorState
          message={branches.error ?? "Could not load branches."}
          onRetry={branches.reload}
        />
      </Screen>
    );
  }

  const { allowance, main } = branches.data;
  const blocked =
    allowance.cap === 0
      ? `${allowance.planName ?? "Your plan"} does not include branches. Max does.`
      : !allowance.active
        ? "Your plan has to be active — clear any due first."
        : allowance.used >= allowance.cap
          ? `${allowance.planName} includes ${allowance.cap}, and all are in use.`
          : null;

  return (
    <Screen
      header={header}
      onRefresh={branches.refresh}
      refreshing={branches.refreshing}
      scroll
    >
      <View className="gap-5 pt-1">
        <View className="gap-3">
          <SectionHeader
            subtitle={`${allowance.used} of ${allowance.cap} on ${allowance.planName ?? "your plan"} · no extra cost`}
            title="Your branches"
          />
          <Card className="gap-1 px-0 py-1">
            {[main, ...branches.data.branches].map((branch) => {
              const status = STATUS[branch.status] ?? {
                label: branch.status,
                tone: "neutral" as const,
              };
              const cover = absoluteMediaUrl(branch.coverUrl, API_BASE_URL);

              return (
                <ListRow
                  left={
                    // The switcher's 40pt tile, a step larger here where the list is the whole screen.
                    cover ? (
                      <Image
                        contentFit="cover"
                        source={{ uri: cover }}
                        style={{ borderColor: colors.border, borderRadius: 14, borderWidth: 1, height: 52, width: 52 }}
                      />
                    ) : (
                      <View className="h-[52px] w-[52px] items-center justify-center rounded-[14px] bg-muted">
                        <Glyph color={colors.foreground} name={branch.id === main.id ? "hostel" : "branch"} size={22} />
                      </View>
                    )
                  }
                  onPress={
                    branch.status === "PUBLISHED"
                      ? () => {
                          void setActiveHostelId(
                            branch.id === main.id ? null : branch.id,
                          ).then(() => router.replace("/(admin)"));
                        }
                      : undefined
                  }
                  key={branch.id}
                  right={<Badge label={status.label} tone={status.tone} />}
                  subtitle={[branch.area, branch.city]
                    .filter(Boolean)
                    .join(", ")}
                  title={branch.name}
                />
              );
            })}
          </Card>
        </View>

        {blocked ? (
          <Card>
            <Text variant="caption">{blocked}</Text>
          </Card>
        ) : (
          <Button label="Add a branch" onPress={() => router.push("/manage/branch-new")} />
        )}
      </View>
    </Screen>
  );
}
