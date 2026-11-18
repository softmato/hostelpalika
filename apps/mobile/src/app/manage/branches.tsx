import { Image } from "expo-image";
import { router } from "expo-router";
import { type ReactNode, useState } from "react";
import { Pressable, View } from "react-native";

import { useBranchesLock } from "@/components/hostel-switcher";
import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Glyph } from "@/components/ui/glyph";
import { Input } from "@/components/ui/input";
import { ListRow } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonCard } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { setActiveHostelId } from "@/lib/active-hostel";
import { getBranches, setBranchLabel } from "@/lib/admin-api";
import { readApiError } from "@/lib/api-contract";
import { toastError, toastSuccess } from "@/lib/toast";
import { API_BASE_URL } from "@/lib/api";
import { absoluteMediaUrl } from "@/lib/media";

const STATUS: Record<
  string,
  { label: string; tone: "neutral" | "success" | "warning" | "danger" }
> = {
  DRAFT: { label: "KYC to finish", tone: "warning" },
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
        <EmptyState icon="lock-closed" title={lock} tone="warning" />
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
  const [editing, setEditing] = useState<{ id: string; label: string; name: string } | null>(null);
  const [saving, setSaving] = useState(false);

  async function saveLabel() {
    if (!editing || !editing.label.trim()) return toastError("Add a label", "Something short, like Block B.");
    setSaving(true);
    try {
      await setBranchLabel(editing.id, editing.label.trim());
      setEditing(null);
      toastSuccess("Label saved");
      branches.reload();
    } catch (error) {
      toastError("Could not save", readApiError(error, "That did not save."));
    } finally {
      setSaving(false);
    }
  }

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
          <Card className="gap-1" padding="px-4 py-1">
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
                        cachePolicy="memory-disk"
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
                  right={
                    <View className="items-end gap-1">
                      {branch.id === main.id ? <Badge label="Main hostel" tone="info" /> : null}
                      <Badge label={status.label} tone={status.tone} />
                      <Pressable
                        accessibilityLabel={`Edit label for ${branch.name}`}
                        accessibilityRole="button"
                        className="flex-row items-center gap-1 active:opacity-60"
                        hitSlop={8}
                        onPress={() => setEditing({ id: branch.id, label: branch.branchLabel ?? "", name: branch.name })}
                      >
                        <Text className="text-primary" style={{ fontSize: 12 }} variant={null}>
                          {branch.branchLabel || "Add label"}
                        </Text>
                        <Glyph color={colors.primary} name="pencil" size={12} />
                      </Pressable>
                    </View>
                  }
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

      <Sheet
        footer={<Button label="Save" loading={saving} onPress={() => void saveLabel()} />}
        onClose={() => setEditing(null)}
        open={editing !== null}
        title="Branch label"
      >
        <View className="gap-3 pb-2">
          <Input
            hint={`How you tell ${editing?.name ?? "this hostel"} apart, like Block B or Thamel branch.`}
            label="Label"
            maxLength={40}
            onChangeText={(label) => setEditing((prev) => (prev ? { ...prev, label } : prev))}
            value={editing?.label ?? ""}
          />
        </View>
      </Sheet>
    </Screen>
  );
}
