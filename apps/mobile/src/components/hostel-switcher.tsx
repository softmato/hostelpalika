import { Image } from "expo-image";
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
import { type BranchName, getBranchesSummary, getBranchNames } from "@/lib/admin-api";
import { adminQuery } from "@/lib/admin-queries";
import { API_BASE_URL } from "@/lib/api";
import { absoluteMediaUrl } from "@/lib/media";
import { toastError } from "@/lib/toast";
import type { GlyphName } from "@hostel/constants/glyphs";

/**
 * An owner with branches works in one hostel at a time. The chip at the top of
 * Home says which hostel this is — its first exterior photo, or a plain glyph in
 * the text colour — and opens the list: the hostels first, Overall after them.
 *
 * A warden gets the same chip and list, read-only: names only, their own
 * hostel ticked, the rest dimmed, no Overall and no Manage branches.
 */

const BRANCHES_KEY = "admin:branches";
const BRANCH_NAMES_KEY = "admin:branch-names";

function useBranches(warden: boolean) {
  return useResource<{ current?: string | null; hostels: BranchName[] }>(
    warden ? getBranchNames : getBranchesSummary,
    { cacheKey: warden ? BRANCH_NAMES_KEY : BRANCHES_KEY },
  );
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
 * Why Branches is closed, or null when it is open — the web portal's
 * `branchesLock`: Max only, owner only. `undefined` while the plan loads.
 */
export function useBranchesLock(): string | null | undefined {
  const role = useAppSelector((state) => state.auth.account?.role);
  const query = adminQuery.subscription();
  const subscription = useResource(query.load, { cacheKey: query.key, topics: query.topics });

  if (subscription.loading) return undefined;
  if (subscription.data?.subscription.planId !== "max") return "You need the Max plan to use branches.";

  return role === ROLE.HOSTEL_ADMIN ? null : "Only the hostel owner can manage branches.";
}

/** Switch into one branch, then open the screen there — every write from Overall starts this way. */
export function openInBranch(branch: { id: string; isBranch: boolean }, route: string) {
  void setActiveHostelId(branch.isBranch ? branch.id : null).then(() => {
    if (route.startsWith("/(admin)")) router.navigate(route as never);
    else router.push(route as never);
  });
}

/**
 * Switching remounts screens with the selected branch's cached answers.
 */
async function switchTo(row: BranchName, rows: BranchName[]) {
  await setActiveHostelId(
    row.id === rows[0]?.id && !row.isBranch ? null : row.id,
  );
}

function currentRow(rows: BranchName[], active: string | null) {
  return (
    rows.find((row) => row.id === active) ??
    rows.find((row) => !row.isBranch) ??
    rows[0]
  );
}

export function HostelSwitcher({ compact = false }: { compact?: boolean }) {
  const { colors } = useAppTheme();
  const warden = useAppSelector((state) => state.auth.account?.role) === ROLE.WARDEN;
  const branches = useBranches(warden);
  const subscriptionQuery = adminQuery.subscription();
  const subscription = useResource(subscriptionQuery.load, {
    cacheKey: subscriptionQuery.key,
    topics: subscriptionQuery.topics,
  });
  const active = useActiveHostel();
  const lock = useBranchesLock();
  const [open, setOpen] = useState(false);
  const rows = branches.data?.hostels ?? [];
  const overall = !warden && isOverall(active);

  // Still shown in Overall whatever the plan says, so the way out never disappears.
  // A warden's hostel with no branches has nothing to show.
  if (
    warden
      ? rows.length < 2
      : rows.length === 0 || (subscription.data?.subscription.planId !== "max" && !overall)
  )
    return null;

  const current = warden
    ? rows.find((row) => row.id === branches.data?.current) ?? rows[0]
    : currentRow(rows, active);
  const cover = (row: BranchName | undefined) =>
    row ? absoluteMediaUrl(row.coverUrl, API_BASE_URL) : null;
  const tile = (name: GlyphName, on: boolean, image?: string | null) =>
    image ? (
      <Image
        contentFit="cover"
        source={{ uri: image }}
        style={{
          borderColor: on ? colors.primary : colors.border,
          borderRadius: 12,
          borderWidth: on ? 2 : 1,
          height: 40,
          width: 40,
        }}
      />
    ) : (
      <View className={`h-10 w-10 items-center justify-center rounded-xl ${on ? "bg-foreground" : "bg-muted"}`}>
        <Glyph color={on ? colors.background : colors.foreground} name={name} size={20} />
      </View>
    );
  const headerImage = overall ? null : cover(current);
  const mark = (on: boolean) =>
    on ? <Glyph color={colors.primary} name="check" size={18} strokeWidth={2} /> : null;

  return (
    <View className={compact ? "shrink-0" : "px-5 pt-3"}>
      <Pressable
        accessibilityLabel={
          overall
            ? "Viewing all branches. Switch view"
            : `Working in ${current?.name}. ${warden ? "See branches" : "Switch branch"}`
        }
        accessibilityRole="button"
        accessibilityHint={warden ? "Lists the hostel's branches" : "Choose a hostel or manage your branches"}
        accessibilityState={{ expanded: open }}
        className={
          compact
            ? "min-h-11 min-w-11 flex-row items-center justify-center gap-1 rounded-full border border-border bg-card px-2 active:bg-muted"
            : "flex-row items-center gap-2 self-start rounded-full border border-border bg-card px-3.5 py-2 active:bg-muted"
        }
        onPress={() => setOpen(true)}
      >
        {headerImage ? (
          <Image
            contentFit="cover"
            source={{ uri: headerImage }}
            style={{ borderRadius: 999, height: 26, width: 26 }}
          />
        ) : (
          <Glyph
            color={colors.foreground}
            name={overall ? "overall" : current?.isBranch ? "branch" : "hostel"}
            size={16}
          />
        )}
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

      <Sheet bare onClose={() => setOpen(false)} open={open} title={warden ? "Branches" : "Switch hostel"}>
        <View className="gap-4 px-4 pb-10 pt-4">
          <View className="gap-1.5">
            <Text className="px-1" variant="label">
              {warden ? "This hostel and its branches" : "Your hostels"}
            </Text>
            <View className="overflow-hidden rounded-2xl bg-card">
              {rows.map((row, at) => {
                const selected = !overall && row.id === current?.id;
                return (
                  <View key={row.id}>
                    {at ? <View className="ml-[72px] h-px bg-border" /> : null}
                    <SheetRow
                      disabled={warden && !selected}
                      label={row.name}
                      leading={tile(row.isBranch ? "branch" : "hostel", selected, cover(row))}
                      onPress={() => {
                        setOpen(false);
                        if (!selected && !warden) void switchTo(row, rows);
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
          {rows.length > 1 && !warden ? (
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
          {warden ? null : <Pressable
            accessibilityRole="button"
            className="flex-row items-center justify-center gap-2 rounded-2xl border border-dashed border-border py-3.5 active:bg-muted"
            onPress={() => {
              setOpen(false);
              if (lock) toastError(lock);
              else router.push("/manage/branches");
            }}
          >
            <Glyph color={lock ? colors.mutedForeground : colors.primary} name="plus" size={18} />
            <Text className={`font-semibold ${lock ? "text-muted-foreground" : "text-primary"}`} variant={null}>
              Manage branches
            </Text>
          </Pressable>}
        </View>
      </Sheet>
    </View>
  );
}
