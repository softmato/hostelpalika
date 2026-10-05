import { router } from "expo-router";
import { useState, useSyncExternalStore } from "react";
import { Pressable, View } from "react-native";

import { Glyph } from "@/components/ui/glyph";
import { Sheet, SheetRow } from "@/components/ui/sheet";
import { Text } from "@/components/ui/text";
import { ROLE } from "@/constants/roles";
import { useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import {
  getActiveHostelId,
  isOverall,
  OVERALL,
  setActiveHostelId,
  subscribeActiveHostel,
} from "@/lib/active-hostel";
import { type AdminBranchRow, getBranchesSummary } from "@/lib/admin-api";
import { adminQuery } from "@/lib/admin-queries";
import { formatMoney } from "@/lib/format";
import type { GlyphName } from "@hostel/constants/glyphs";

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
 * Whether the tabs should show every branch at once. Owner only: a stale value
 * left on a shared phone never puts a warden into a view they cannot read.
 */
export function useIsOverall() {
  const role = useAppSelector((state) => state.auth.account?.role);

  return isOverall(useActiveHostel()) && role === ROLE.HOSTEL_ADMIN;
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
  const [open, setOpen] = useState(false);
  const rows = branches.data?.hostels ?? [];
  const overall = isOverall(active);

  // Still shown in Overall whatever the plan says, so the way out never disappears.
  if (rows.length === 0 || (subscription.data?.subscription.planId !== "max" && !overall))
    return null;

  const current = currentRow(rows, active);
  const tile = (name: GlyphName, on: boolean) => (
    <View className={`h-10 w-10 items-center justify-center rounded-xl ${on ? "bg-primary" : "bg-brand-soft"}`}>
      <Glyph color={on ? colors.primaryForeground : colors.primary} name={name} size={20} />
    </View>
  );
  const mark = (on: boolean) =>
    on ? <Glyph color={colors.primary} name="check" size={18} strokeWidth={2} /> : null;

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
        <Glyph
          color={colors.primary}
          name={overall ? "overall" : current?.isBranch ? "branch" : "hostel"}
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
        <Glyph color={colors.mutedForeground} name="chevronDown" size={14} />
      </Pressable>

      <Sheet
        bare
        fitContent
        onClose={() => setOpen(false)}
        open={open}
        title="Switch hostel"
      >
        <View className="gap-4 px-4 py-4">
          {rows.length > 1 ? (
            <View className="overflow-hidden rounded-2xl bg-card">
              <SheetRow
                label="Overall"
                leading={tile("overall", overall)}
                onPress={() => {
                  setOpen(false);
                  if (!overall) void setActiveHostelId(OVERALL);
                }}
                selected={overall}
                subtitle={`All ${rows.length} branches together`}
                trailing={mark(overall)}
              />
            </View>
          ) : null}
          <View className="gap-1.5">
            <Text className="px-1" variant="label">
              Your hostels
            </Text>
            <View className="overflow-hidden rounded-2xl bg-card">
              {rows.map((row, at) => {
                const selected = !overall && row.id === current?.id;
                return (
                  <View key={row.id}>
                    {at ? <View className="ml-[72px] h-px bg-border" /> : null}
                    <SheetRow
                      label={row.name}
                      leading={tile(row.isBranch ? "branch" : "hostel", selected)}
                      onPress={() => {
                        setOpen(false);
                        if (!selected) void switchTo(row, rows);
                      }}
                      selected={selected}
                      subtitle={[
                        row.isBranch ? "Branch" : "Main hostel",
                        [row.area, row.city].filter(Boolean).join(", "),
                      ].filter(Boolean).join(" · ")}
                      trailing={mark(selected)}
                    />
                  </View>
                );
              })}
            </View>
          </View>
          <Pressable
            accessibilityRole="button"
            className="flex-row items-center justify-center gap-2 rounded-2xl border border-dashed border-border py-3.5 active:bg-muted"
            onPress={() => {
              setOpen(false);
              router.push("/manage/branches");
            }}
          >
            <Glyph color={colors.primary} name="plus" size={18} />
            <Text className="font-semibold text-primary" variant={null}>
              Manage branches
            </Text>
          </Pressable>
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
                <Glyph
                  color={colors.primary}
                  name={row.isBranch ? "branch" : "hostel"}
                  size={20}
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
                <Glyph color={colors.mutedForeground} name="chevron" size={16} />
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
