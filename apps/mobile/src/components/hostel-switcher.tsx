import { Ionicons } from "@expo/vector-icons";
import { router, usePathname } from "expo-router";
import { useState, useSyncExternalStore } from "react";
import { Pressable, View } from "react-native";

import { Sheet, SheetRow } from "@/components/ui/sheet";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import {
  getActiveHostelId,
  setActiveHostelId,
  subscribeActiveHostel,
} from "@/lib/active-hostel";
import { type AdminBranchRow, getBranchesSummary } from "@/lib/admin-api";
import { adminQuery } from "@/lib/admin-queries";
import { formatMoney } from "@/lib/format";

/**
 * An owner with branches works in one hostel at a time. These two read the
 * same summary: the chip at the top of Home says which hostel this is and opens
 * the list, and the card lower down puts every hostel's figures side by side.
 * The switcher also offers branch management for an owner with one hostel.
 */

const BRANCHES_KEY = "admin:branches";

function useBranches() {
  return useResource(getBranchesSummary, { cacheKey: BRANCHES_KEY });
}

function useActiveHostel() {
  return useSyncExternalStore(
    subscribeActiveHostel,
    getActiveHostelId,
    getActiveHostelId,
  );
}

/**
 * Switching remounts screens with the selected branch's cached answers.
 */
async function switchTo(row: AdminBranchRow, rows: AdminBranchRow[]) {
  await setActiveHostelId(
    row.id === rows[0]?.id && !row.isBranch ? null : row.id,
  );
}

function currentRow(rows: AdminBranchRow[], active: string | null) {
  return (
    rows.find((row) => row.id === active) ??
    rows.find((row) => !row.isBranch) ??
    rows[0]
  );
}

export function HostelSwitcher({ compact = false }: { compact?: boolean }) {
  const { colors } = useAppTheme();
  const branches = useBranches();
  const subscriptionQuery = adminQuery.subscription();
  const subscription = useResource(subscriptionQuery.load, {
    cacheKey: subscriptionQuery.key,
    topics: subscriptionQuery.topics,
  });
  const active = useActiveHostel();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const rows = branches.data?.hostels ?? [];
  const overall = pathname.endsWith("/manage/overall");

  if (rows.length === 0 || subscription.data?.subscription.planId !== "max")
    return null;

  const current = currentRow(rows, active);

  return (
    <View className={compact ? "shrink-0" : "px-5 pt-3"}>
      <Pressable
        accessibilityLabel={
          overall
            ? "Viewing all branches. Switch view"
            : `Working in ${current?.name}. Switch branch`
        }
        accessibilityRole="button"
        accessibilityHint="Choose a hostel or manage your branches"
        accessibilityState={{ expanded: open }}
        className={
          compact
            ? "min-h-11 min-w-11 flex-row items-center justify-center gap-1 rounded-full border border-border bg-card px-2 active:bg-muted"
            : "flex-row items-center gap-2 self-start rounded-full border border-border bg-card px-3.5 py-2 active:bg-muted"
        }
        onPress={() => setOpen(true)}
      >
        <Ionicons
          color={colors.primary}
          name={overall ? "layers-outline" : "business-outline"}
          size={16}
        />
        {compact ? null : (
          <Text
            className="max-w-[220px] font-semibold text-foreground"
            numberOfLines={1}
            variant={null}
          >
            {overall ? "Overall" : current?.name}
          </Text>
        )}
        <Ionicons
          color={colors.mutedForeground}
          name="chevron-down"
          size={14}
        />
      </Pressable>

      <Sheet
        bare
        fitContent
        onClose={() => setOpen(false)}
        open={open}
        title="Switch branch"
      >
        <View className="gap-2 px-4 pt-4">
          {rows.length > 1 ? (
            <View
              className={`mb-2 overflow-hidden rounded-2xl border ${overall ? "border-primary/20 bg-brand-soft" : "border-border bg-card"}`}
            >
              <SheetRow
                label="Overall · all branches"
                subtitle="Residents, staff, money, operations and reports together"
                leading={
                  <View
                    className={`h-11 w-11 items-center justify-center rounded-xl ${overall ? "bg-primary/10" : "bg-muted"}`}
                  >
                    <Ionicons
                      color={overall ? colors.primary : colors.mutedForeground}
                      name="layers-outline"
                      size={22}
                    />
                  </View>
                }
                onPress={() => {
                  setOpen(false);
                  if (!overall) router.push("/manage/overall");
                }}
                selected={overall}
                trailing={
                  overall ? (
                    <View className="flex-row items-center gap-1 rounded-full bg-primary/10 px-2 py-1">
                      <Ionicons
                        color={colors.primary}
                        name="checkmark"
                        size={13}
                      />
                      <Text className="text-primary" variant="caption">
                        Active
                      </Text>
                    </View>
                  ) : (
                    <Ionicons
                      color={colors.mutedForeground}
                      name="chevron-forward"
                      size={17}
                    />
                  )
                }
              />
            </View>
          ) : null}
          <Text className="mb-1 px-1" variant="caption">
            Your hostels
          </Text>
          {rows.map((row) => {
            const selected = !overall && row.id === current?.id;
            return (
              <View
                className={`overflow-hidden rounded-2xl border ${selected ? "border-primary/20 bg-brand-soft" : "border-border bg-card"}`}
                key={row.id}
              >
                <SheetRow
                  label={row.name}
                  leading={
                    <View
                      className={`h-11 w-11 items-center justify-center rounded-xl ${selected ? "bg-primary/10" : "bg-muted"}`}
                    >
                      <Ionicons
                        color={
                          selected ? colors.primary : colors.mutedForeground
                        }
                        name="business-outline"
                        size={22}
                      />
                    </View>
                  }
                  onPress={() => {
                    setOpen(false);
                    if (overall) {
                      void switchTo(row, rows).then(() =>
                        router.replace("/(admin)"),
                      );
                    } else if (!selected) {
                      void switchTo(row, rows);
                    }
                  }}
                  selected={selected}
                  subtitle={
                    [row.area, row.city].filter(Boolean).join(", ") || row.slug
                  }
                  trailing={
                    selected ? (
                      <View className="flex-row items-center gap-1 rounded-full bg-primary/10 px-2 py-1">
                        <Ionicons
                          color={colors.primary}
                          name="checkmark"
                          size={13}
                        />
                        <Text className="text-primary" variant="caption">
                          Active
                        </Text>
                      </View>
                    ) : (
                      <Ionicons
                        color={colors.mutedForeground}
                        name="chevron-forward"
                        size={17}
                      />
                    )
                  }
                />
              </View>
            );
          })}
        </View>
        <View className="mx-4 mt-4 border-t border-border pt-1">
          <SheetRow
            label="Manage branches"
            leading={
              <View className="h-11 w-11 items-center justify-center rounded-xl bg-muted">
                <Ionicons
                  color={colors.mutedForeground}
                  name="git-network-outline"
                  size={21}
                />
              </View>
            }
            onPress={() => {
              setOpen(false);
              router.push("/manage/branches");
            }}
            subtitle="Add a branch or check its setup"
            trailing={
              <Ionicons
                color={colors.mutedForeground}
                name="chevron-forward"
                size={17}
              />
            }
          />
        </View>
      </Sheet>
    </View>
  );
}

export function BranchesCard() {
  const { colors } = useAppTheme();
  const branches = useBranches();
  const active = useActiveHostel();
  const rows = branches.data?.hostels ?? [];

  if (rows.length < 2) return null;

  const current = currentRow(rows, active);

  return (
    <View className="gap-3">
      <View className="gap-1 px-1">
        <Text variant="subtitle">Your hostels</Text>
        <Text variant="caption">Choose a hostel to open its workspace.</Text>
      </View>
      {rows.map((row) => {
        const selected = row.id === current?.id;
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected }}
            className="gap-4 rounded-2xl border border-border bg-card p-4 active:bg-brand-soft"
            key={row.id}
            onPress={selected ? undefined : () => void switchTo(row, rows)}
          >
            <View className="flex-row items-center gap-3">
              <View className="h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-soft">
                <Ionicons
                  color={colors.primary}
                  name="business-outline"
                  size={21}
                />
              </View>
              <Text
                className="flex-1 text-sm font-semibold text-foreground"
                numberOfLines={2}
                variant={null}
              >
                {row.name}
              </Text>
              {selected ? (
                <View className="rounded-full bg-brand-soft px-2 py-1">
                  <Text
                    className="text-xs font-semibold text-primary"
                    variant={null}
                  >
                    Active
                  </Text>
                </View>
              ) : (
                <Ionicons
                  color={colors.mutedForeground}
                  name="arrow-forward"
                  size={18}
                />
              )}
            </View>
            <View className="flex-row flex-wrap gap-y-3 border-t border-border pt-4">
              <BranchMetric
                label="Residents"
                value={row.residents.toLocaleString()}
              />
              <BranchMetric
                label="Occupancy"
                value={
                  row.occupancyPercent === null
                    ? "—"
                    : `${row.occupancyPercent}%`
                }
                detail={`${row.beds} beds`}
              />
              <BranchMetric
                label="Collected"
                value={formatMoney(row.collected)}
              />
              <BranchMetric
                label="Due"
                value={row.due > 0 ? formatMoney(row.due) : "—"}
                warning={row.due > 0}
              />
              <BranchMetric
                label="Complaints"
                value={row.openComplaints.toLocaleString()}
              />
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

function BranchMetric({
  detail,
  label,
  value,
  warning = false,
}: {
  detail?: string;
  label: string;
  value: string;
  warning?: boolean;
}) {
  return (
    <View className="w-1/2 pr-3">
      <Text variant="caption">{label}</Text>
      <Text
        className={`text-sm font-semibold ${warning ? "text-warning" : "text-foreground"}`}
        variant={null}
      >
        {value}
      </Text>
      {detail ? <Text variant="caption">{detail}</Text> : null}
    </View>
  );
}
