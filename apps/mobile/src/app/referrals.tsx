import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { useCallback } from "react";
import { Pressable, Share, View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Avatar } from "@/components/ui/avatar";
import { Badge, StatusPill } from "@/components/ui/badge";
import { Card, SectionHeader } from "@/components/ui/card";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { SkeletonCard } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { formatMoney } from "@/lib/format";
import { type Referral, type ResidentReferral } from "@/lib/referral-api";
import {
  buildReferralShare,
  describeRewards,
  referralStatusLabel,
} from "@/lib/referrals";
import { residentQuery } from "@/lib/resident-queries";
import { toastSuccess } from "@/lib/toast";

/**
 * Refer a friend.
 *
 * Structure follows `apps/web/src/app/_components/resident-referral-page.tsx`:
 * the code in large tracked type, the share row, the three tiles (Sent · Joined ·
 * Converted) with its hint copy, the rewards sentence, then the referred-inquiry
 * list with a status badge each. Only the controls are native — the web's
 * "Copy link" becomes a share sheet, and its three-column tile grid becomes a row.
 *
 * ## The share sends the code, not the link
 *
 * The web copies `/inquiry?ref=<code>` to the clipboard, and the page that link
 * opens ignores `ref` — so following it credits nobody. Rather than reproduce a
 * control that silently costs the resident a reward, the share sends the **code**,
 * which works both in this app (`app/ref/[code].tsx`) and at the hostel desk
 * (`linkReferralOnRegistration`). The link is not shown at all until the website
 * honours it. Reasoning and the unwind condition are in `lib/referrals.ts`.
 *
 * ## Opening this screen is what mints the code
 *
 * `getResidentReferral` creates the `ReferralCode` if there is none — in the GET.
 * So there is no "generate my code" button to build, and a resident who has never
 * referred anybody still lands on a real code.
 */

export default function ReferralsScreen() {
  const query = residentQuery.referral();
  const referral = useResource<ResidentReferral>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  const header = <AppBar accent centerTitle showBack title="Refer a friend" />;

  if (referral.loading) {
    return (
      <Screen header={header}>
        <View className="gap-4 pt-1">
          <SkeletonCard rows={3} />
          <SkeletonCard rows={2} />
        </View>
      </Screen>
    );
  }

  if (referral.error || !referral.data) {
    return (
      <Screen header={header}>
        <ErrorState
          message={referral.error ?? "Your referral code could not be loaded."}
          onRetry={referral.reload}
        />
      </Screen>
    );
  }

  return (
    <ReferralBody data={referral.data} header={header} resource={referral} />
  );
}

function ReferralBody({
  data,
  header,
  resource,
}: {
  data: ResidentReferral;
  header: React.ReactNode;
  resource: { refresh: () => void; refreshing: boolean };
}) {
  const { colors } = useAppTheme();
  const { referralCode, referrals, summary } = data;

  const copyCode = useCallback(async () => {
    await Clipboard.setStringAsync(referralCode.code);
    toastSuccess("Code copied");
  }, [referralCode.code]);

  const share = useCallback(async () => {
    try {
      await Share.share({
        message: buildReferralShare({ code: referralCode.code }),
      });
    } catch {
      // Dismissed, or the platform refused. The code is on screen and copyable,
      // so there is nothing worth interrupting anybody about.
    }
  }, [referralCode.code]);

  return (
    <Screen
      header={header}
      onRefresh={resource.refresh}
      refreshing={resource.refreshing}
      scroll
    >
      <View className="gap-5 pt-1">
        <Card padding="p-6" className="items-center gap-4">
          <View className="h-16 w-16 items-center justify-center rounded-2xl bg-brand-soft">
            <Ionicons color={colors.primary} name="gift-outline" size={32} />
          </View>
          <View className="items-center gap-1">
            <Text variant="title">Invite a friend</Text>
            <Text className="text-center" variant="muted">
              Share your code when they enquire.
            </Text>
          </View>

          <Pressable
            accessibilityHint="Copies the code"
            accessibilityLabel={`Referral code ${referralCode.code}`}
            accessibilityRole="button"
            className="w-full items-center rounded-2xl border border-dashed border-border bg-muted px-3 py-4 active:opacity-70"
            onPress={() => void copyCode()}
          >
            <Text
              className="text-center"
              adjustsFontSizeToFit
              numberOfLines={1}
              minimumFontScale={0.65}
              style={{
                color: colors.primary,
                fontSize: 34,
                fontWeight: "800",
                letterSpacing: 4,
              }}
            >
              {referralCode.code}
            </Text>
          </Pressable>

          <Text className="text-center" variant="caption">
            Tap to copy
          </Text>

          <Pressable
            accessibilityRole="button"
            className="mt-1 h-11 w-full flex-row items-center justify-center gap-2 rounded-xl active:opacity-85"
            onPress={() => void share()}
            style={{ backgroundColor: colors.primary }}
          >
            <Ionicons
              color={colors.primaryForeground}
              name="share-social"
              size={17}
            />
            <Text
              className="font-semibold"
              style={{ color: colors.primaryForeground }}
            >
              Share my code
            </Text>
          </Pressable>
        </Card>

        <Card padding="p-5" className="gap-4">
          <Text variant="subtitle">Your referrals</Text>
          <View className="flex-row flex-wrap gap-y-3">
            {[
              { label: "Referred", value: summary.sent },
              { label: "Joined", value: summary.joined },
              { label: "First payment", value: summary.converted },
            ].map((item) => (
              <View
                key={item.label}
                className="flex-1 gap-1 pr-2"
                style={{ minWidth: 72 }}
              >
                <Text variant="title">{item.value}</Text>
                <Text variant="caption">{item.label}</Text>
              </View>
            ))}
          </View>
        </Card>

        <Card padding="p-5" className="gap-2">
          <Text variant="label">Rewards</Text>
          <Text variant="muted">
            {describeRewards(summary, referralCode.rewardCount)}
          </Text>
        </Card>

        {/*
          No "copy link" here: the page the link opens ignores `ref` and credits
          nobody, so the code is the only thing worth sharing.
        */}
        <View>
          <SectionHeader title="Who you have referred" />

          {referrals.length === 0 ? (
            <EmptyState title="No referrals yet" />
          ) : (
            <Card padding="px-4 py-1">
              {referrals.map((referral, index) => (
                <View key={referral.id}>
                  {index > 0 ? <RowDivider inset /> : null}
                  <ReferralRow referral={referral} />
                </View>
              ))}
            </Card>
          )}
        </View>
      </View>
    </Screen>
  );
}

function ReferralRow({ referral }: { referral: Referral }) {
  const dates = useDates();

  const reward = referral.reward;

  return (
    <ListRow
      left={<Avatar name={referral.name} size="sm" />}
      right={
        reward && reward.amount > 0 ? (
          <View className="items-end gap-0.5">
            <Text variant="label">{formatMoney(reward.amount)}</Text>
            <StatusPill status={reward.status} />
          </View>
        ) : referral.converted ? (
          // `converted` is its own field — a JOINED referral may not have paid yet.
          <Badge label="Converted" tone="success" />
        ) : (
          <StatusPill status={referral.status} />
        )
      }
      subtitle={`${referralStatusLabel(referral.status)} · ${dates.relativeDay(referral.createdAt)}`}
      title={referral.name}
    />
  );
}
