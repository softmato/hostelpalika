import { Ionicons } from "@expo/vector-icons";
import {
  bestDiscountPercent,
  bestEventPercent,
  bestSaving,
  billingCycles,
  cardServicesForPlan,
  cycleTotal,
  monthlyRateFor,
  planBelow,
  planRank,
  portalAccessLines,
  residentRangeLabel,
  savingFor,
  type BillingCycle,
  type PlanTierLike,
} from "@hostel/plans/catalog";
import { router } from "expo-router";
import { useCallback, useState } from "react";
import { View } from "react-native";

import { InfoHeader } from "@/components/info-page";
import { PlanMark } from "@/components/plan-mark";
import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Screen } from "@/components/ui/screen";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton, SkeletonCard } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useSiteConfig } from "@/hooks/use-site-config";
import type { SitePlans } from "@/lib/site-config-api";

/**
 * Plans, for a hostel owner.
 *
 * Everything comes from Platform → Website Config → Plans & Pricing — the same
 * `plans` section the website's `/plans-pricing` renders — and every figure on
 * this screen is computed by `@hostel/plans/catalog`, the same file the website
 * calls. A plan carries one monthly price and a discount per longer cycle; the
 * six-month and annual totals are derived, so the app and the site cannot quote
 * different numbers.
 *
 * Nothing here is hardcoded, which is why this is the one screen in the set with
 * a real loading and error state: plans are entirely owner-authored, and
 * inventing three tiers as a fallback would be fiction printed next to a
 * currency symbol.
 *
 * ## What the website has and this does not
 *
 * The comparison table. Ten feature rows against three columns is a 4-column
 * grid at 360dp, and every honest way to draw it on a phone — horizontal
 * scroll, a column picker, stacked repeats — turns a glanceable table into a
 * task. The per-plan feature list carries the same information in the shape a
 * phone reads, so the table would be a second, harder copy of it.
 *
 * The per-service detail pages are not here either. They are a page each on the
 * website; on a phone they belong behind the service rows rather than as forty
 * screens reachable only from a pricing list — see `tasks.md`.
 *
 * The FAQ is on the Contact screen, where the platform's configured FAQ lives,
 * rather than duplicated per page.
 */
export default function PricingScreen() {
  const { config, error, loading, refresh, refreshing } = useSiteConfig();
  const { identity, plans: catalog } = config;
  const [cycle, setCycle] = useState<BillingCycle>("annual");
  const closingToRegister = catalog.page.ctaHref.includes("register");

  /*
   * The registration wizard, in the app. This was a browser tab until 2026-08-19
   * — see `register-hostel/apply.tsx` for why the "the documents are on a
   * computer" argument did not survive contact with the device.
   */
  const openRegistration = useCallback(() => {
    router.push("/register-hostel/apply");
  }, []);

  const empty = catalog.plans.length === 0;
  const bestDiscount = bestDiscountPercent(catalog, cycle);
  // Only ever above zero while an event is actually running: the server stamps
  // the offer price onto the catalogue, so the phone has nothing to decide.
  const eventPercent = bestEventPercent(catalog);

  return (
    <Screen
      header={<AppBar showBack title="Pricing" />}
      onRefresh={refresh}
      refreshing={refreshing}
      scroll
    >
      <View className="gap-8 pb-4">
        <InfoHeader
          icon="pricetags-outline"
          subtitle={catalog.page.subtitle}
          title={catalog.page.title}
        />

        {loading ? (
          <View className="gap-3">
            <Skeleton height={40} radius={20} />
            <SkeletonCard rows={3} />
            <SkeletonCard rows={3} />
          </View>
        ) : null}

        {!loading && error && empty ? (
          <ErrorState message={error} onRetry={refresh} />
        ) : null}

        {!loading && !error && empty ? (
          <EmptyState
            description="No plans have been published yet. Get in touch and we'll talk you through what a listing costs."
            title="Pricing is on its way"
          />
        ) : null}

        {empty ? null : (
          <View className="gap-3">
            <Segmented
              onChange={setCycle}
              options={billingCycles(catalog).map((option) => ({
                label: option.label,
                value: option.id,
              }))}
              value={cycle}
            />
            {/* Never on monthly outside an event: a saving on screen while
                monthly is selected advertises a discount the reader is not
                currently getting. In rupees during one, because the event
                zeroes the cycle discounts and a percentage would read "0%". */}
            {eventPercent > 0 || (cycle !== "monthly" && bestDiscount > 0) ? (
              <View className="self-center rounded-full bg-brand-soft px-3 py-1">
                <Text className="text-xs font-semibold text-primary" variant={null}>
                  {eventPercent > 0
                    ? `Save up to ${money(bestSaving(catalog, cycle))}`
                    : `Save up to ${bestDiscount}%`}
                </Text>
              </View>
            ) : null}
            {/* The event rides every cycle, so unlike the pill above it this one
                shows on monthly too. */}
            {eventPercent > 0 ? (
              <View className="self-center rounded-full bg-primary px-3 py-1">
                <Text
                  className="text-xs font-bold text-primary-foreground"
                  variant={null}
                >
                  {catalog.event.label} — {eventPercent}% off
                </Text>
              </View>
            ) : null}
            {eventPercent > 0 && catalog.event.note ? (
              <Text className="text-center text-xs text-muted-foreground" variant={null}>
                {catalog.event.note}
              </Text>
            ) : null}
          </View>
        )}

        {catalog.plans.map((plan) => (
          <PlanCard
            catalog={catalog}
            cycle={cycle}
            featuredBadge={catalog.page.featuredBadge}
            key={plan.id}
            onPress={openRegistration}
            plan={plan}
          />
        ))}

        {catalog.page.footnote ? (
          <Text className="text-center" variant="caption">
            {fill(catalog.page.footnote, identity.siteName)}
          </Text>
        ) : null}

        {empty ? null : (
          <Card className="items-center gap-2 border-primary/25 bg-brand-soft p-6">
            <Text className="text-center text-lg font-bold text-foreground" variant={null}>
              {fill(catalog.page.ctaTitle, identity.siteName)}
            </Text>
            <Text className="text-center leading-6" variant="muted">
              {fill(catalog.page.ctaBody, identity.siteName)}
            </Text>
            {/* The website's closing button goes wherever `ctaHref` says —
                Contact by default — so the app follows it rather than always
                opening registration under someone else's label. */}
            <Button
              className="mt-3 self-stretch"
              label={
                fill(catalog.page.ctaLabel, identity.siteName) ||
                (closingToRegister ? "Start your registration" : "Get in touch")
              }
              onPress={closingToRegister ? openRegistration : () => router.push("/contact")}
            />
          </Card>
        )}
      </View>
    </Screen>
  );
}

/**
 * Stored copy cannot interpolate, so it carries `{siteName}` and the client
 * replaces it — the same two braces the website substitutes, so an owner who
 * renames the platform renames it in both.
 */
function fill(text: string, siteName: string) {
  return text.replaceAll("{siteName}", siteName);
}

function money(rupees: number) {
  return `NPR ${rupees.toLocaleString("en-IN")}`;
}

/**
 * One plan, in the website card's order (`apps/web/.../plans-cards.tsx`): mark,
 * name and badge, price, the saving, the button, then the ticks.
 *
 * The feature list no longer collapses. With the button above the list, the
 * price and the action are read before the ticks start, so a long list costs a
 * scroll rather than a hidden decision — and it is the same list the website
 * shows in full.
 */
function PlanCard({
  catalog,
  cycle,
  featuredBadge,
  onPress,
  plan,
}: {
  catalog: SitePlans;
  cycle: BillingCycle;
  featuredBadge: string;
  onPress: () => void;
  plan: PlanTierLike;
}) {
  const { colors } = useAppTheme();
  const below = planBelow(catalog, plan.id);
  const tier = plan.listingTier;
  // One "was" figure, never two: an event and a cycle discount both come off
  // the same list price, so that list price is what gets struck through.
  const struck = plan.listMonthly ?? (cycle === "monthly" ? null : plan.monthly);
  const saving = savingFor(plan, cycle);

  return (
    <View className={plan.featured ? "pt-3" : ""}>
      {/* Spacing is the card's `gap` between grouped blocks, not per-item
          margins: `mt-6`/`mt-7` on the button and divider did not reach the
          device, and the button sat flush against the saving pill. */}
      <Card className={`gap-5 ${plan.featured ? "border-primary" : ""}`}>
        <View className="gap-3">
          <View className="flex-row items-center gap-3">
            <View className="h-11 w-11 items-center justify-center rounded-xl bg-brand-soft">
              <PlanMark color={colors.primary} rank={planRank(catalog, plan.id)} />
            </View>
            <View className="min-w-0 flex-1 items-start gap-1.5">
              <Text className="text-2xl font-bold text-foreground" variant={null}>
                {plan.name}
              </Text>
              {/* Gold reads as warning, platinum as neutral: the palette has no
                  metal colours and the badge is a label, not an alarm. */}
              {tier ? (
                <Badge label={tier.label} tone={tier.tone === "gold" ? "warning" : "neutral"} />
              ) : null}
            </View>
          </View>

          {plan.description ? (
            <Text className="text-sm text-foreground" variant={null}>
              {plan.description}
            </Text>
          ) : null}
        </View>

        <View className="items-start gap-3">
          {plan.freeMonths ? (
            <Text className="text-sm font-semibold text-primary" variant={null}>
              First {plan.freeMonths} {plan.freeMonths === 1 ? "month" : "months"} free, then
            </Text>
          ) : null}
          {/* Annual keeps the monthly figure beside it, struck through, so the
              discount has something to be compared against. */}
          <View className="flex-row flex-wrap items-baseline gap-2.5">
            <Money
              className="text-3xl font-bold text-foreground"
              currencyClassName="text-lg text-foreground"
              rupees={monthlyRateFor(plan, cycle)}
            />
            {struck === null ? null : (
              <Money
                className="text-base font-semibold text-muted-foreground line-through"
                currencyClassName="text-xs text-muted-foreground"
                rupees={struck}
              />
            )}
          </View>

          <Text className="text-sm text-foreground" variant={null}>
            {cycle === "monthly"
              ? "Paid every month."
              : `${cycle === "annual" ? "One year costs" : "Six months cost"} ${money(
                  cycleTotal(plan, cycle),
                )}, paid once.`}
          </Text>

          {saving > 0 ? (
            <View className="rounded-full bg-brand-soft px-2.5 py-1">
              <Text className="text-xs font-semibold text-primary" variant={null}>
                Save {money(saving)}
              </Text>
            </View>
          ) : null}
        </View>

        <Button
          label={plan.ctaLabel}
          onPress={onPress}
          variant={plan.featured ? "primary" : "outline"}
        />

        <View className="gap-2 border-t border-border pt-5">
          <Text className="pb-1 text-sm font-bold text-foreground" variant={null}>
            {below ? `Everything in ${below.name}, plus:` : "Included:"}
          </Text>

          {/* Capacity first — it is what the price is set by — then who gets an
              account per role, then the badge. These carry the plan's own terms
              and lead in foreground; the services under them read a step back. */}
          <PlanLine color={colors.primary}>{residentRangeLabel(catalog, plan)}</PlanLine>
          {portalAccessLines(catalog, plan).map((line) => (
            <PlanLine color={colors.primary} key={line.id}>
              {line.label}
            </PlanLine>
          ))}
          {tier ? (
            <PlanLine
              color={tier.tone === "gold" ? colors.warning : colors.mutedForeground}
              note={tier.note}
            >
              {`${tier.label} badge`}
            </PlanLine>
          ) : null}
          {cardServicesForPlan(catalog, plan.id).map((service) => (
            <PlanLine color={colors.primary} key={service.slug} muted>
              {service.name}
            </PlanLine>
          ))}
        </View>
      </Card>

      {/* The featured pill straddles the card's top edge, as on the website. */}
      {plan.featured && featuredBadge ? (
        <View className="absolute left-6 top-0 rounded-full bg-primary px-3 py-1">
          <Text
            className="text-xs font-bold uppercase tracking-wider text-primary-foreground"
            variant={null}
          >
            {featuredBadge}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** "NPR" set smaller and muted so the eye lands on the figure being compared. */
function Money({
  className,
  currencyClassName,
  rupees,
}: {
  className: string;
  /** React Native has no `em`, so the smaller currency size is passed in. */
  currencyClassName: string;
  rupees: number;
}) {
  return (
    <Text className={className} variant={null}>
      <Text className={`font-semibold ${currencyClassName}`} variant={null}>
        NPR{" "}
      </Text>
      {rupees.toLocaleString("en-IN")}
    </Text>
  );
}

function PlanLine({
  children,
  color,
  muted = false,
  note,
}: {
  children: string;
  color: string;
  muted?: boolean;
  note?: string;
}) {
  return (
    <View className="flex-row items-start gap-2.5">
      <Ionicons color={color} name="checkmark" size={16} style={{ marginTop: 2 }} />
      {/* Solid foreground for both weights: `text-foreground/80` does not
          compose onto a CSS-variable colour in NativeWind and rendered grey. */}
      <Text
        className={`flex-1 text-sm text-foreground ${muted ? "font-medium" : "font-semibold"}`}
        variant={null}
      >
        {children}
        {note ? (
          <Text className="text-sm font-normal text-muted-foreground" variant={null}>
            {` — ${note}`}
          </Text>
        ) : null}
      </Text>
    </View>
  );
}
