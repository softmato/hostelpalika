import { Ionicons } from "@expo/vector-icons";
import { useState, useSyncExternalStore } from "react";
import { Pressable, View } from "react-native";

import { Card } from "@/components/ui/card";
import { ListRow } from "@/components/ui/list-row";
import { Money } from "@/components/ui/money";
import { Sheet, SheetRow } from "@/components/ui/sheet";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { getActiveHostelId, setActiveHostelId, subscribeActiveHostel } from "@/lib/active-hostel";
import { type AdminBranchRow, getBranchesSummary } from "@/lib/admin-api";
import { clearQueryCache } from "@/lib/query-cache";

/**
 * An owner with branches works in one hostel at a time. These two read the
 * same summary: the chip at the top of Home says which hostel this is and opens
 * the list, and the card lower down puts every hostel's figures side by side.
 * Both render nothing for an owner with one hostel.
 */

const BRANCHES_KEY = "admin:branches";

function useBranches() {
  return useResource(getBranchesSummary, { cacheKey: BRANCHES_KEY });
}

function useActiveHostel() {
  return useSyncExternalStore(subscribeActiveHostel, getActiveHostelId, getActiveHostelId);
}

/**
 * Every cached screen belongs to the hostel it was read for, so a switch empties
 * the cache and each screen reads its new hostel on the way back in.
 */
async function switchTo(row: AdminBranchRow, rows: AdminBranchRow[]) {
  // The main hostel is the default: storing nothing for it keeps an older
  // session's stale id from pinning the account to a branch.
  await setActiveHostelId(row.isBranch || rows[0]?.id !== row.id ? row.id : null);
  clearQueryCache();
}

function currentRow(rows: AdminBranchRow[], active: string | null) {
  return rows.find((row) => row.id === active) ?? rows.find((row) => !row.isBranch) ?? rows[0];
}

export function HostelSwitcher() {
  const { colors } = useAppTheme();
  const branches = useBranches();
  const active = useActiveHostel();
  const [open, setOpen] = useState(false);
  const rows = branches.data?.hostels ?? [];

  if (rows.length < 2) return null;

  const current = currentRow(rows, active);

  return (
    <View className="px-5 pt-3">
      <Pressable
        accessibilityLabel={`Working in ${current?.name}. Switch hostel`}
        accessibilityRole="button"
        className="flex-row items-center gap-2 self-start rounded-full border border-border bg-card px-3.5 py-2 active:bg-muted"
        onPress={() => setOpen(true)}
      >
        <Ionicons color={colors.primary} name="business-outline" size={16} />
        <Text className="max-w-[220px] font-semibold text-foreground" numberOfLines={1} variant={null}>
          {current?.name}
        </Text>
        <Ionicons color={colors.mutedForeground} name="chevron-down" size={14} />
      </Pressable>

      <Sheet bare onClose={() => setOpen(false)} open={open} title="Your hostels">
        {rows.map((row) => (
          <SheetRow
            key={row.id}
            label={row.name}
            onPress={() => {
              setOpen(false);
              void switchTo(row, rows);
            }}
            selected={row.id === current?.id}
            subtitle={`${row.isBranch ? "Branch" : "Main hostel"} · ${row.residents} residents`}
          />
        ))}
      </Sheet>
    </View>
  );
}

export function BranchesCard() {
  const branches = useBranches();
  const active = useActiveHostel();
  const rows = branches.data?.hostels ?? [];

  if (rows.length < 2) return null;

  const current = currentRow(rows, active);

  return (
    <View className="gap-3">
      <Text variant="label">Your hostels</Text>
      <Card className="gap-1 px-0 py-1">
        {rows.map((row) => (
          <ListRow
            icon={row.isBranch ? "git-branch-outline" : "business-outline"}
            key={row.id}
            onPress={row.id === current?.id ? undefined : () => void switchTo(row, rows)}
            right={<Money size="inline" value={row.collected} />}
            subtitle={`${row.residents} residents · ${row.occupancyPercent ?? 0}% full · ${row.openComplaints} open complaints`}
            title={row.id === current?.id ? `${row.name} · here now` : row.name}
          />
        ))}
      </Card>
    </View>
  );
}
