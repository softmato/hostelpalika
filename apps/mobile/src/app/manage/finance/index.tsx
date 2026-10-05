import { router } from "expo-router";
import { View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Card, SectionHeader } from "@/components/ui/card";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { SkeletonRows } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { payoutAccountSummary, usePayoutAccount } from "@/components/manage/payout-account-card";
import { WalletMark, walletLabel } from "@/components/ui/wallet-mark";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { GATEWAY_PROVIDERS } from "@/lib/admin-manage-api";
import { khataQuery, lateFineRate } from "@/lib/khata-api";
import { type AdminFinanceData, adminQuery, prefetchAdminRoute } from "@/lib/admin-queries";

/**
 * Finance — a menu, the way the hostel's own Settings is one.
 *
 * ## Every block is its own screen
 *
 * This screen used to draw the rate cards, the festival months, the payment
 * profile and the gateways one under another, with an Edit on each. It read as
 * a report, and the controls that mattered — dropping rates that had not
 * started — were two screens deep behind a button labelled for something else.
 * Now each subject is one row with its state as the subtitle, and the row opens
 * the screen that owns it: `finance/room-rates`, `finance/month-discounts`,
 * `finance/payment-setup`, `finance/gateway/[provider]`. Returning revalidates
 * silently (`useResource` refetches on refocus), so a change there shows here.
 *
 * ## Billing is not on this screen at all
 *
 * `cron/billing-cycle` issues the month's invoices on the 1st and
 * `cron/payment-reminders` chases them. The month's invoices are the **Money**
 * tab's subject — this screen only decides what they say.
 *
 * ## Three capabilities, not one
 *
 * Reading wants `viewPayments`; the rates want `manageFeeSchedule`; the profile
 * and the gateways want `managePaymentProfile`. A block the warden cannot open
 * comes back `null`, and its row says so instead of opening onto a refusal.
 */

const NO_ACCESS = "You don't have access to this";

export default function ManageFinanceScreen() {
  const dates = useDates();

  const query = adminQuery.finance();
  const finance = useResource<AdminFinanceData>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  const schedules = finance.data?.schedules ?? null;
  const profile = finance.data?.profile ?? null;
  const gateways = finance.data?.gateways ?? null;
  const concessions = finance.data?.concessions ?? null;
  // Owner-only on the server: a warden's read is refused, and the row says so.
  const payout = usePayoutAccount();
  const lateFineQuery = khataQuery.lateFine();
  const lateFine = useResource(lateFineQuery.load, {
    cacheKey: lateFineQuery.key,
    topics: lateFineQuery.topics,
  });
  const khataKey = khataQuery.admin();
  const khata = useResource(khataKey.load, { cacheKey: khataKey.key, topics: khataKey.topics });

  const header = <AppBar accent centerTitle showBack title="Finance" />;

  if (finance.loading) {
    return (
      <Screen header={header}>
        <SkeletonRows rows={5} />
      </Screen>
    );
  }

  if (finance.error) {
    return (
      <Screen header={header}>
        <ErrorState message={finance.error} onRetry={finance.reload} />
      </Screen>
    );
  }

  /*
   * `standing` is decided by the server: the open card is *not* the live one for
   * the month between saving new rates and them starting.
   */
  const current = schedules?.find((schedule) => schedule.standing === "current") ?? null;
  const upcoming = schedules?.find((schedule) => schedule.standing === "upcoming") ?? null;

  const ratesSubtitle =
    schedules === null
      ? NO_ACCESS
      : upcoming
        ? `${current ? "New rates" : "Nothing charging now · rates"} start ${dates.dateBoth(upcoming.effectiveFrom)}`
        : current
          ? `${current.rates.length} room type${current.rates.length === 1 ? "" : "s"} · charging now`
          : "Not set — nobody can be billed";

  const activeDiscounts = (concessions ?? []).filter((row) => row.standing !== "past");
  const discountsSubtitle =
    concessions === null
      ? NO_ACCESS
      : activeDiscounts.length > 0
        ? activeDiscounts.map((row) => `${row.label} ${row.percentOff}% off`).join(" · ")
        : "Every month at full rent";

  const warm = (href: string) => () => prefetchAdminRoute(href);

  return (
    <Screen
      header={header}
      onRefresh={finance.refresh}
      refreshing={finance.refreshing}
      scroll
    >
      <View className="gap-5 pt-1">
        <View>
          <SectionHeader title="Rates" />
          <Card padding="px-4 py-1">
            <ListRow
              icon="pricetags-outline"
              iconBgColor="#34C759"
              onPress={schedules === null ? undefined : () => router.push("/manage/finance/room-rates")}
              onPressIn={warm("/manage/finance/room-rates")}
              subtitle={ratesSubtitle}
              title="Room rates"
            />
            <RowDivider inset />
            <ListRow
              icon="gift-outline"
              iconBgColor="#FF9500"
              onPress={concessions === null ? undefined : () => router.push("/manage/finance/month-discounts")}
              onPressIn={warm("/manage/finance/month-discounts")}
              subtitle={discountsSubtitle}
              title="Festival discounts"
            />
            <RowDivider inset />
            <ListRow
              icon="alarm-outline"
              iconBgColor="#FF3B30"
              onPress={lateFine.error ? undefined : () => router.push("/manage/finance/late-fine")}
              right={
                lateFine.data ? (
                  <Badge
                    label={lateFine.data.enabled ? "On" : "Off"}
                    tone={lateFine.data.enabled ? "success" : "neutral"}
                  />
                ) : undefined
              }
              subtitle={
                lateFine.error
                  ? NO_ACCESS
                  : !lateFine.data
                    ? "…"
                    : lateFine.data.enabled
                      ? `${lateFineRate(lateFine.data)} after day ${lateFine.data.graceDays}`
                      : "No fine for paying late"
              }
              title="Late fine"
            />
          </Card>
        </View>

        <View>
          <SectionHeader title="Khata" />
          <Card padding="px-4 py-1">
            <ListRow
              icon="receipt-outline"
              iconBgColor="#AF52DE"
              onPress={khata.error ? undefined : () => router.push("/manage/finance/khata")}
              right={
                khata.data && khata.data.requests.length + khata.data.waiting.length > 0 ? (
                  <Badge
                    label={`${khata.data.requests.length + khata.data.waiting.length} new`}
                    tone="warning"
                  />
                ) : undefined
              }
              subtitle={
                khata.error
                  ? NO_ACCESS
                  : !khata.data
                    ? "…"
                    : `${khata.data.accounts.length} open · ${khata.data.items.filter((item) => item.active).length} items`
              }
              title="Resident khata"
            />
          </Card>
        </View>

        <View>
          <SectionHeader title="Getting paid" />
          <Card padding="px-4 py-1">
            <ListRow
              icon="qr-code-outline"
              iconBgColor="#007AFF"
              onPress={profile === null ? undefined : () => router.push("/manage/finance/payment-setup")}
              onPressIn={warm("/manage/finance/payment-setup")}
              subtitle={
                profile === null
                  ? NO_ACCESS
                  : profile.usable
                    ? `${profile.displayName || "Not named yet"} · residents can pay`
                    : "Not set up — residents can't pay yet"
              }
              title="Payment setup"
            />
            <RowDivider inset />
            <ListRow
              icon="documents-outline"
              iconBgColor="#5E5CE6"
              onPress={() => router.push("/manage/statements")}
              subtitle="Match payments to your bank and wallet"
              title="Bank and wallet statements"
            />
            <RowDivider inset />
            <ListRow
              icon="wallet-outline"
              iconBgColor="#34C759"
              onPress={payout.error ? undefined : () => router.push("/manage/finance/payouts")}
              subtitle={
                payout.error
                  ? NO_ACCESS
                  : payout.loading
                    ? "…"
                    : payoutAccountSummary(payout.data ?? null)
              }
              title="Booking payouts"
            />
          </Card>
        </View>

        <View>
          <SectionHeader title="Online payment" />
          <Card padding="px-4 py-1">
            {GATEWAY_PROVIDERS.map((provider, index) => {
              const entry = gateways?.find((config) => config.provider === provider);

              return (
                <View key={provider}>
                  {index > 0 ? <RowDivider inset /> : null}
                  <ListRow
                    left={<WalletMark name={provider} size={32} />}
                    onPress={
                      gateways === null ? undefined : () => router.push(`/manage/finance/gateway/${provider}`)
                    }
                    right={
                      gateways === null ? undefined : (
                        <Badge
                          label={
                            entry?.payable
                              ? "On"
                              : entry?.enabled
                                ? "Blocked"
                                : entry?.secret.configured
                                  ? "Off"
                                  : "Not set up"
                          }
                          tone={
                            entry?.payable ? "success" : entry?.enabled ? "warning" : "neutral"
                          }
                        />
                      )
                    }
                    subtitle={gateways === null ? NO_ACCESS : undefined}
                    title={walletLabel(provider)}
                  />
                </View>
              );
            })}
          </Card>
        </View>
      </View>
    </Screen>
  );
}
