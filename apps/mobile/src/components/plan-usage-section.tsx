import { freeTierLines } from "@hostel/plans/catalog";
import { router } from "expo-router";
import { Pressable, View } from "react-native";

import { PlanMark } from "@/components/plan-mark";
import { Card, SectionHeader } from "@/components/ui/card";
import { Glyph } from "@/components/ui/glyph";
import { Meter } from "@/components/ui/meter";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { useSiteConfig } from "@/hooks/use-site-config";
import { adminQuery } from "@/lib/admin-queries";
import type { PlanSeat, PlanUsage } from "@/lib/admin-manage-api";

const SEATS: { id: PlanSeat; label: string }[] = [
  { id: "residents", label: "Residents" },
  { id: "wardens", label: "Warden accounts" },
  { id: "cooks", label: "Cook accounts" },
];

/** The hostel's seats against its plan, refreshed by the residents and payments topics. */
export function usePlanUsage() {
  const query = adminQuery.planUsage();
  return useResource<PlanUsage | null>(query.load, { cacheKey: query.key, topics: query.topics }).data ?? null;
}

function shortDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function overLine(usage: PlanUsage) {
  return SEATS.filter(({ id }) => usage.caps[id] !== null && usage.used[id] > usage.caps[id]!)
    .map(({ id, label }) => `${usage.used[id]} ${label.toLowerCase()} (covers ${usage.caps[id]})`)
    .join(", ");
}

/**
 * Amber while a free-tier hostel is over its caps, red once the portal is
 * read-only; taps through to Billing. Nothing while within the caps.
 */
export function PlanLimitBanner({ usage }: { usage: PlanUsage | null }) {
  const { colors } = useAppTheme();

  if (!usage?.overLimit || !usage.readOnlyFrom) return null;

  const tone = usage.readOnly ? colors.destructive : colors.warning;

  return (
    <Pressable accessibilityRole="button" onPress={() => router.push("/manage/billing")}>
      <Card className={`flex-row items-start gap-3 ${usage.readOnly ? "border-destructive/40" : "border-warning/40"}`}>
        <Glyph color={tone} name={usage.readOnly ? "lock-closed" : "alert-circle"} size={20} />
        <View className="flex-1 gap-1">
          <Text className="text-sm font-bold text-foreground" variant={null}>
            {usage.readOnly ? "Your portal is read-only" : `Read-only from ${shortDate(usage.readOnlyFrom)}`}
          </Text>
          <Text className="text-xs text-muted-foreground" variant={null}>
            {`You have ${overLine(usage)} on ${usage.planName ?? "Free"}. Choose a plan, or move residents out.`}
          </Text>
        </View>
        <Glyph color={colors.mutedForeground} name="chevron-forward" size={18} />
      </Card>
    </Pressable>
  );
}

/**
 * Billing's plan block: the seats against the caps, then every plan — Free
 * first — marked "fits" or with the seat that does not, so the choice is made
 * with the hostel's own numbers in front of it.
 */
export function PlanUsageSection({ usage }: { usage: PlanUsage | null }) {
  const { colors } = useAppTheme();
  const { config } = useSiteConfig();

  if (!usage || usage.state === "none") return null;

  const free = config.plans.free;
  const options = [
    ...(free
      ? [{ caps: { cooks: free.portalAccess.cooks, residents: free.maxResidents, wardens: free.portalAccess.wardens }, id: "free", name: free.name }]
      : []),
    ...config.plans.plans.map((plan) => ({
      caps: { cooks: plan.portalAccess.cooks, residents: plan.maxResidents, wardens: plan.portalAccess.wardens },
      id: plan.id,
      name: plan.name,
    })),
  ];
  const trial = usage.state === "trial";

  return (
    <View className="gap-3">
      <PlanLimitBanner usage={usage} />

      <View>
        <SectionHeader title={trial ? "Your usage" : `On ${usage.planName ?? "your plan"}`} />
        <Card className="gap-4">
          {SEATS.map(({ id, label }) => {
            const cap = trial ? null : usage.caps[id];
            const used = usage.used[id];
            const over = cap !== null && used > cap;

            return (
              <View className="gap-1.5" key={id}>
                <View className="flex-row items-baseline justify-between">
                  <Text className="text-sm text-muted-foreground" variant={null}>
                    {label}
                  </Text>
                  <Text className={`text-sm font-bold ${over ? "text-destructive" : "text-foreground"}`} variant={null}>
                    {`${used} / ${cap === null ? "Unlimited" : cap}`}
                  </Text>
                </View>
                <Meter label={null} percent={cap === null ? null : cap === 0 ? 100 : Math.round((used / cap) * 100)} reading="elapsed" />
              </View>
            );
          })}
        </Card>
      </View>

      <View>
        <SectionHeader title={trial ? "After your trial" : "Which plan fits"} />
        <Card className="gap-0 p-0">
          {options.map((option, index) => {
            const short = SEATS.filter(({ id }) => option.caps[id] !== null && usage.used[id] > option.caps[id]!);
            const current = (usage.state === "free" && option.id === "free") || (usage.state === "paid" && option.name === usage.planName);

            return (
              <View className={`flex-row items-center gap-3 px-4 py-3 ${index > 0 ? "border-t border-border" : ""}`} key={option.id}>
                <PlanMark color={colors.primary} free={option.id === "free"} rank={Math.max(0, index - 1)} size={22} />
                <View className="flex-1">
                  <Text className="text-sm font-bold text-foreground" variant={null}>
                    {option.name}
                    {current ? <Text className="text-xs font-normal text-muted-foreground" variant={null}>{"  · current"}</Text> : null}
                  </Text>
                  {option.id === "free" && free && short.length === 0 ? (
                    <Text className="text-xs text-muted-foreground" variant={null}>
                      {freeTierLines(free).join(" · ")}
                    </Text>
                  ) : null}
                </View>
                {short.length === 0 ? (
                  <View className="flex-row items-center gap-1">
                    <Glyph color={colors.primary} name="checkmark" size={16} />
                    <Text className="text-sm font-semibold text-primary" variant={null}>
                      Fits
                    </Text>
                  </View>
                ) : (
                  <Text className="max-w-[45%] text-right text-xs font-semibold text-destructive" variant={null}>
                    {short.map(({ id, label }) => `${usage.used[id]}/${option.caps[id]} ${label.split(" ")[0].toLowerCase()}`).join(" · ")}
                  </Text>
                )}
              </View>
            );
          })}
        </Card>
      </View>
    </View>
  );
}
