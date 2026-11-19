import AsyncStorage from "@react-native-async-storage/async-storage";
import { Image } from "expo-image";
import { router } from "expo-router";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
} from "react-native-reanimated";

import { branchPhoto, photographBranch } from "@/components/branch-sweep";
import { Glyph } from "@/components/ui/glyph";
import { Sheet, SheetRow } from "@/components/ui/sheet";
import { Text } from "@/components/ui/text";
import { Toggle } from "@/components/ui/toggle";
import { ROLE } from "@/constants/roles";
import { useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import {
  getActiveHostelId,
  getChosenHostelId,
  isOverall,
  OVERALL,
  setActiveHostelId,
  subscribeActiveHostel,
} from "@/lib/active-hostel";
import { type BranchName, getBranchesSummary, getBranchNames } from "@/lib/admin-api";
import { adminQuery, prefetchBranchHome } from "@/lib/admin-queries";
import { API_BASE_URL } from "@/lib/api";
import { absoluteMediaUrl } from "@/lib/media";
import { fetchQuery, inQueryScope, readQuery } from "@/lib/query-cache";
import { serverAnswers } from "@/lib/server-reachable";
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

// Account-wide: after a switch the list must still be there offline, or the
// switcher hides and there is no way back to the other branch.
const BRANCHES_KEY = "account:admin:branches";

/**
 * The owner's choice to show the branch label on the chip, from the sheet's own
 * switch. Per phone, remembered; on until switched off.
 */
const LABEL_KEY = "switcher:show-label";
let showLabel = true;
const labelListeners = new Set<() => void>();
const readShowLabel = () => showLabel;
function subscribeShowLabel(listener: () => void) {
  labelListeners.add(listener);
  return () => void labelListeners.delete(listener);
}
function setShowLabel(next: boolean) {
  showLabel = next;
  labelListeners.forEach((listener) => listener());
  AsyncStorage.setItem(LABEL_KEY, next ? "1" : "0").catch(() => null);
}
AsyncStorage.getItem(LABEL_KEY)
  .then((saved) => saved === "0" && setShowLabel(false))
  .catch(() => null);
const BRANCH_NAMES_KEY = "account:admin:branch-names";

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

  const sub = subscription.data?.subscription;
  const now = Date.now();
  const paidLive =
    Boolean(sub?.planId) && (Boolean(sub?.lifetimeSince) || Date.parse(sub?.currentPeriodEnd ?? "") > now);
  // The trial is everything in Max (the server's `branchPlan`), until a plan is paid.
  const trial = !paidLive && Date.parse(sub?.trialEndsAt ?? "") > now;

  if (sub?.planId !== "max" && !trial) return "You need the Max plan to use branches.";

  return role === ROLE.HOSTEL_ADMIN ? null : "Only the hostel owner can manage branches.";
}

/**
 * Changes the active hostel only when the server answers. Offline, the other
 * branch has nothing cached, so the switch left Home on "Something went wrong"
 * with the switcher gone and no way back (owner, 2026-11-16).
 */
async function setActiveWhenOnline(id: string | null) {
  // A cached card paints offline too, so only an empty branch waits on the health read.
  if (!homeCached(id) && !(await serverAnswers())) {
    toastError("You are offline", "Switch branch when the internet is back.");
    return false;
  }
  await setActiveHostelId(id, () =>
    Promise.all([isOverall(id) ? null : warmBranch(), branchPhoto()]),
  );
  return true;
}

function homeCached(id: string | null) {
  return !isOverall(id) && inQueryScope(id, () => readQuery(adminQuery.overview().key) !== null);
}

/** Past this, a slow line lands on Home's skeleton rather than on a switcher that seems to do nothing. */
const WARM_CAP_MS = 2500;

/**
 * Runs once requests point at the new branch. Normally a no-op: the chip's
 * press-in already filed the card's two reads (`prefetchBranchHome`), so the
 * switch lands at once. Waits only for whatever of them is still missing.
 */
function warmBranch() {
  const home = adminQuery.overview();
  const ledger = adminQuery.ledger();

  return Promise.race([
    Promise.all([
      readQuery(home.key) ? null : fetchQuery(home.key, home.load, home.topics),
      readQuery(ledger.key) ? null : fetchQuery(ledger.key, ledger.load, ledger.topics),
    ]),
    new Promise((resolve) => setTimeout(resolve, WARM_CAP_MS)),
  ]);
}

/** Switch into one branch, then open the screen there — every write from Overall starts this way. */
export function openInBranch(branch: { id: string; isBranch: boolean }, route: string) {
  void setActiveWhenOnline(branch.isBranch ? branch.id : null).then((switched) => {
    if (!switched) return;
    if (route.startsWith("/(admin)")) router.navigate(route as never);
    else router.push(route as never);
  });
}

/**
 * Switching remounts screens with the selected branch's cached answers.
 */
async function switchTo(row: BranchName, rows: BranchName[]) {
  await setActiveWhenOnline(scopeOf(row, rows));
}

/** The main hostel works under no id; a branch under its own. */
function scopeOf(row: BranchName, rows: BranchName[]) {
  return row.id === rows[0]?.id && !row.isBranch ? null : row.id;
}

function currentRow(rows: BranchName[], active: string | null) {
  return (
    rows.find((row) => row.id === active) ??
    rows.find((row) => !row.isBranch) ??
    rows[0]
  );
}

/**
 * "Switched" slides in from the chip's left edge, holds, then slides out to the
 * right, as a pill over the chip's own content. Transform only: the chip never
 * resizes, so nothing re-lays out per frame. Frame-stepped like the wipe, with
 * each step capped, so the stall of mounting the new branch pauses it instead
 * of skipping it. Unmounts itself when done.
 */
const SWITCHED_MS = 1500;
/** The share of the run spent sliding in, and again sliding out. */
const SLIDE = 420 / SWITCHED_MS;
const MAX_STEP = 1000 / 30;
/** Material standard ease: gentle start, soft landing. */
const ease = Easing.bezierFn(0.4, 0, 0.2, 1);

function SwitchedLabel({
  at,
  background,
  color,
  onDone,
}: {
  at: number;
  background: string;
  color: string;
  onDone: (at: number) => void;
}) {
  const t = useSharedValue(0);
  const width = useSharedValue(0);

  useFrameCallback(({ timeSincePreviousFrame }) => {
    if (t.value >= 1) return;
    t.value = Math.min(t.value + Math.min(timeSincePreviousFrame ?? 0, MAX_STEP) / SWITCHED_MS, 1);
    if (t.value >= 1) runOnJS(onDone)(at);
  });

  const style = useAnimatedStyle(() => {
    const p = t.value;
    const x = p < SLIDE ? ease(p / SLIDE) - 1 : p > 1 - SLIDE ? ease((p - 1 + SLIDE) / SLIDE) : 0;

    return { opacity: width.value ? 1 : 0, transform: [{ translateX: x * width.value }] };
  });

  return (
    <Animated.View
      onLayout={(event) => width.set(event.nativeEvent.layout.width)}
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        { alignItems: "center", backgroundColor: background, justifyContent: "center" },
        style,
      ]}
    >
      <Text className="font-semibold" numberOfLines={1} style={{ color, fontSize: 13 }} variant={null}>
        Switched
      </Text>
    </Animated.View>
  );
}

export function HostelSwitcher({
  compact = false,
  label = true,
}: {
  compact?: boolean;
  /** Adds a small tag beside the chip: the branch's own label, else "Main" / "Branch". */
  label?: boolean;
}) {
  const { colors } = useAppTheme();
  const warden = useAppSelector((state) => state.auth.account?.role) === ROLE.WARDEN;
  const branches = useBranches(warden);
  const subscriptionQuery = adminQuery.subscription();
  const subscription = useResource(subscriptionQuery.load, {
    cacheKey: subscriptionQuery.key,
    topics: subscriptionQuery.topics,
  });
  // The pick, ahead of the screens while its Home loads (`setActiveHostelId`).
  const active = useSyncExternalStore(subscribeActiveHostel, getChosenHostelId, getChosenHostelId);
  const switching = active !== useActiveHostel();
  const lock = useBranchesLock();
  const [open, setOpen] = useState(false);
  const [switchedAt, setSwitchedAt] = useState(0);
  const shownId = useRef<string | null | undefined>(undefined);
  /*
   * The pick runs once the sheet is fully down. Switching while it slid away
   * rebuilt every tab under it, so the sheet froze open for seconds and the
   * swap played behind it (device timing, 2026-11-17).
   */
  const afterClose = useRef<(() => void) | null>(null);
  const rows = branches.data?.hostels ?? [];
  const overall = !warden && isOverall(active);
  const shown = useActiveHostel();
  const labelOn = useSyncExternalStore(subscribeShowLabel, readShowLabel, readShowLabel);

  useEffect(() => {
    // Skip the first paint; every later change of branch plays the label once.
    if (shownId.current !== undefined && shownId.current !== shown) setSwitchedAt(Date.now());
    shownId.current = shown;
  }, [shown]);

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
        cachePolicy="memory-disk"
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
    on ? <Glyph color={colors.primary} name="checkmark" size={18} strokeWidth={2} /> : null;

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
        accessibilityState={{ busy: switching, expanded: open }}
        className={
          compact
            ? "min-h-11 min-w-11 flex-row items-center justify-center gap-1 overflow-hidden rounded-full border border-border bg-card px-2 active:bg-muted"
            : "flex-row items-center gap-2 self-start overflow-hidden rounded-full border border-border bg-card px-3.5 py-2 active:bg-muted"
        }
        onPress={() => setOpen(true)}
        // A finger on the chip is the earliest sign of a switch: file every other
        // hostel's card now, so whichever is picked paints the moment it is.
        onPressIn={() => {
          if (warden) return;
          for (const row of rows) {
            const scope = scopeOf(row, rows);
            if (scope !== active) prefetchBranchHome(scope, row.id);
          }
        }}
        style={switching ? { opacity: 0.55 } : undefined}
      >
        {headerImage ? (
          <Image
            cachePolicy="memory-disk"
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
        {label && labelOn && (overall || current) ? (
          <Text
            className="max-w-[84px] font-semibold text-muted-foreground"
            numberOfLines={1}
            style={{ fontSize: 11 }}
            variant={null}
          >
            {overall ? "All" : current?.branchLabel || (current?.isBranch ? "Branch" : "Main")}
          </Text>
        ) : null}
        <Glyph color={colors.mutedForeground} name="chevron-down" size={14} />
        {/* Last, so it paints over everything in the chip, the chevron too. */}
        {switchedAt ? (
          <SwitchedLabel
            at={switchedAt}
            background={colors.card}
            color={colors.primary}
            key={switchedAt}
            onDone={(at) => setSwitchedAt((now) => (now === at ? 0 : now))}
          />
        ) : null}
      </Pressable>

      <Sheet
        bare
        onClose={() => {
          setOpen(false);
          const run = afterClose.current;
          afterClose.current = null;
          run?.();
        }}
        // The wipe's photo of the screen, taken once the sheet has settled: on the
        // press-in it rasterised the screen on the UI thread as the sheet set off,
        // and the sheet opened late. The sheet is portalled, so it is not in the photo.
        onOpen={warden ? undefined : photographBranch}
        open={open}
        title={warden ? "Branches" : "Switch hostel"}
      >
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
                        afterClose.current =
                          !selected && !warden ? () => void switchTo(row, rows) : null;
                        setOpen(false);
                      }}
                      selected={selected}
                      subtitle={[
                        row.branchLabel || (row.isBranch ? "Branch" : "Main hostel"),
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
                  afterClose.current = overall ? null : () => void setActiveWhenOnline(OVERALL);
                  setOpen(false);
                }}
                selected={overall}
                subtitle={`All ${rows.length} branches together`}
                trailing={mark(overall)}
              />
            </View>
          ) : null}
          {label ? (
            <View className="overflow-hidden rounded-2xl bg-card">
              <SheetRow
                label="Show label"
                leading={tile("pricetag", false)}
                onPress={() => setShowLabel(!labelOn)}
                subtitle="Main or the branch label, beside the name"
                trailing={<Toggle accessibilityLabel="Show label" onChange={setShowLabel} value={labelOn} />}
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
            <Glyph color={lock ? colors.mutedForeground : colors.primary} name="add" size={18} />
            <Text className={`font-semibold ${lock ? "text-muted-foreground" : "text-primary"}`} variant={null}>
              Manage branches
            </Text>
          </Pressable>}
        </View>
      </Sheet>
    </View>
  );
}

/**
 * A push, live banner or Overall bell row about one branch opens in that branch. True when it took over the tap
 * (switching first, then routing); false when the account has one hostel, the
 * push names none, or the app is already there — the caller routes as usual.
 */
export function openInItsBranch(hostelId: unknown, route: string) {
  if (typeof hostelId !== "string") return false;
  const read = (key: string) =>
    readQuery<{ hostels: BranchName[] }>(key, { maxAgeMs: Number.POSITIVE_INFINITY })?.data.hostels;
  const rows = read(BRANCHES_KEY) ?? read(BRANCH_NAMES_KEY) ?? [];
  const row = rows.find((candidate) => candidate.id === hostelId);
  if (rows.length < 2 || !row || scopeOf(row, rows) === getChosenHostelId()) return false;
  openInBranch(row, route);
  return true;
}
