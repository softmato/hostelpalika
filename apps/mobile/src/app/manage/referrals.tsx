import { useCallback, useMemo, useState } from "react";
import { Linking, View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Badge, StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Chip } from "@/components/ui/layout";
import { Money } from "@/components/ui/money";
import { Screen } from "@/components/ui/screen";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import {
  Skeleton,
  SkeletonRows,
  SkeletonTiles,
} from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import {
  confirmReferral,
  type ManagedReferral,
  type ReferralsPayload,
  updateReferralReward,
} from "@/lib/admin-manage-api";
import { adminQuery } from "@/lib/admin-queries";
import { readApiError } from "@/lib/api-contract";
import { humanizeEnum } from "@/lib/format";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Referrals — who your residents brought in, and what you owe them for it.
 *
 * ## Two decisions, and the order between them is enforced
 *
 * A referral arrives as `INQUIRY_CREATED`: somebody used a resident's code to
 * enquire. Confirming it says *they actually moved in* and opens a reward.
 * Recording the payout then moves the reward through PENDING → APPROVED → PAID,
 * and marking it PAID moves the referral itself to REWARDED so the two can never
 * disagree.
 *
 * The server refuses a reward on an unconfirmed referral outright
 * (`REFERRAL_NOT_CONFIRMED`), so the screen only offers the second decision once
 * the first is made — the alternative is an error message explaining an ordering
 * the buttons never showed.
 *
 * ## The summary is the whole hostel, not this list
 *
 * `summary` is computed from every referral in scope regardless of the filter or
 * the page. The service says so in a comment, and it matters here: the segments
 * below change the *list* and leave the figures alone, which is correct and
 * looks like a bug if you do not know it.
 */

type Filter = "" | "INQUIRY_CREATED" | "JOINED" | "REWARDED" | "CANCELLED";

const REWARD_TYPES = [
  {
    description: "Taken off their next invoice.",
    label: "Rent discount",
    value: "DISCOUNT",
  },
  { description: "Handed over directly.", label: "Cash", value: "CASH" },
  {
    description: "Laundry, meals, something in kind.",
    label: "Service credit",
    value: "SERVICE_CREDIT",
  },
  {
    description: "Anything else — say what in the note.",
    label: "Other",
    value: "OTHER",
  },
] as const;

const REWARD_STATUSES = [
  {
    description: "Agreed, not yet approved.",
    label: "Pending",
    value: "PENDING",
  },
  { description: "Approved for payout.", label: "Approved", value: "APPROVED" },
  {
    description: "Handed over. This also marks the referral rewarded.",
    label: "Paid",
    value: "PAID",
  },
  { description: "Not going ahead.", label: "Cancelled", value: "CANCELLED" },
] as const;

export default function ManageReferralsScreen() {
  const dates = useDates();
  const [filter, setFilter] = useState<Filter>("");
  const [open, setOpen] = useState<ManagedReferral | null>(null);
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [rewardType, setRewardType] = useState<string>("DISCOUNT");
  const [rewardStatus, setRewardStatus] = useState<
    "PENDING" | "APPROVED" | "PAID" | "CANCELLED"
  >("APPROVED");
  const [busy, setBusy] = useState(false);

  const query = adminQuery.referrals(filter);
  const referrals = useResource<ReferralsPayload>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  const rows = useMemo(() => referrals.data?.referrals ?? [], [referrals.data]);
  const summary = referrals.data?.summary ?? null;
  const leaders = referrals.data?.topReferrers ?? [];

  const { refresh } = referrals;

  const openReferral = useCallback((referral: ManagedReferral) => {
    setOpen(referral);
    setAmount(referral.reward ? String(referral.reward.amount) : "");
    setNotes(referral.reward?.notes ?? "");
    setRewardType(referral.reward?.rewardType ?? "DISCOUNT");
    setRewardStatus("APPROVED");
  }, []);

  const confirm = useCallback(async () => {
    if (!open) {
      return;
    }

    setBusy(true);

    try {
      await confirmReferral(open.id, {
        rewardAmount: amount.trim() ? Number(amount) : 0,
        rewardNotes: notes.trim() || undefined,
        rewardType,
      });
      toastSuccess(
        "Confirmed",
        "The reward is now recorded against the referrer.",
      );
      setOpen(null);
      await refresh();
    } catch (error) {
      toastError("Could not confirm", readApiError(error));
    } finally {
      setBusy(false);
    }
  }, [amount, notes, open, refresh, rewardType]);

  const saveReward = useCallback(async () => {
    if (!open) {
      return;
    }

    setBusy(true);

    try {
      await updateReferralReward(open.id, {
        amount: amount.trim() ? Number(amount) : undefined,
        notes: notes.trim() || undefined,
        rewardType,
        status: rewardStatus,
      });
      toastSuccess(
        rewardStatus === "PAID"
          ? "Marked paid"
          : `Reward ${humanizeEnum(rewardStatus).toLowerCase()}`,
      );
      setOpen(null);
      await refresh();
    } catch (error) {
      toastError("Could not save", readApiError(error));
    } finally {
      setBusy(false);
    }
  }, [amount, notes, open, refresh, rewardStatus, rewardType]);

  if (referrals.loading) {
    return (
      <Screen header={<AppBar accent centerTitle showBack title="Referrals" />}>
        <View className="gap-4 pt-1">
          <SkeletonTiles />
          <Skeleton height={40} radius={20} />
          <SkeletonRows rows={3} />
        </View>
      </Screen>
    );
  }

  if (referrals.error) {
    return (
      <Screen header={<AppBar accent centerTitle showBack title="Referrals" />}>
        <ErrorState message={referrals.error} onRetry={referrals.reload} />
      </Screen>
    );
  }

  return (
    <Screen
      header={<AppBar accent centerTitle showBack title="Referrals" />}
      onRefresh={referrals.refresh}
      refreshing={referrals.refreshing}
      scroll
    >
      <View className="gap-5 pt-1">
        {summary ? (
          <View className="gap-4">
            <Card padding="p-5" className="gap-4">
              <Text variant="subtitle">Referral overview</Text>
              <View className="flex-row flex-wrap gap-y-3">
                {[
                  { label: "Referred", value: summary.total },
                  { label: "Joined", value: summary.joined },
                  { label: "To confirm", value: summary.pendingConfirmation },
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

            <Card padding="p-5" className="gap-4">
              <View className="flex-row items-center justify-between">
                <Text variant="label">Rewards waiting</Text>
                <Money value={summary.rewardPendingAmount} />
              </View>
              <View className="flex-row items-center justify-between">
                <Text variant="label">Approved</Text>
                <Money value={summary.rewardApprovedAmount} />
              </View>
              <View className="flex-row items-center justify-between">
                <Text variant="label">Paid out</Text>
                <Money value={summary.rewardPaidAmount} />
              </View>
              <Text variant="caption">
                All-time rewards across your hostel.
              </Text>
            </Card>
          </View>
        ) : null}

        <Segmented
          onChange={setFilter}
          options={[
            { label: "All", value: "" },
            { label: "To confirm", value: "INQUIRY_CREATED" },
            { label: "Joined", value: "JOINED" },
            { label: "Rewarded", value: "REWARDED" },
          ]}
          value={filter}
        />

        {rows.length === 0 ? (
          <EmptyCard
            description="Residents share their code from the Refer a friend screen; anyone who enquires with it lands here."
            title="Nothing here yet"
          />
        ) : null}

        {rows.map((referral) => (
          <Card padding="p-5" className="gap-4" key={referral.id}>
            <View className="flex-row items-start gap-2">
              <View className="flex-1">
                <Text variant="subtitle">{referral.name}</Text>
                <Text variant="caption">
                  {`Referred by ${referral.referrerName || "a resident"}`}
                </Text>
              </View>
              <StatusPill status={referral.status} />
            </View>

            <View className="flex-row flex-wrap gap-2">
              {referral.phone ? (
                <Chip
                  icon="call-outline"
                  label={referral.phone}
                  onPress={() => void Linking.openURL(`tel:${referral.phone}`)}
                  tone="brand"
                />
              ) : null}
              {referral.reward ? (
                <Badge
                  label={`${humanizeEnum(referral.reward.rewardType)} · ${humanizeEnum(referral.reward.status)}`}
                  tone={
                    referral.reward.status === "PAID" ? "success" : "warning"
                  }
                />
              ) : null}
            </View>

            {referral.message ? (
              <Text numberOfLines={2} variant="muted">
                {referral.message}
              </Text>
            ) : null}

            <Text variant="caption">
              {`Enquired ${dates.date(referral.createdAt)}${referral.confirmedAt ? ` · joined ${dates.date(referral.confirmedAt)}` : ""}`}
            </Text>

            <Button
              label={
                referral.status === "INQUIRY_CREATED"
                  ? "Confirm they joined"
                  : "Reward"
              }
              onPress={() => openReferral(referral)}
              size="sm"
              variant="outline"
            />
          </Card>
        ))}

        {leaders.length > 0 ? (
          <View>
            <SectionHeader
              subtitle="Residents whose code actually brings people in"
              title="Top referrers"
            />
            <Card className="gap-3">
              {leaders.map((leader) => (
                <View
                  className="flex-row items-center justify-between gap-3"
                  key={leader.id}
                >
                  <View className="flex-1">
                    <Text numberOfLines={1} variant="label">
                      {leader.name}
                    </Text>
                    <Text variant="caption">
                      {`${leader.code}${leader.roomType ? ` · ${leader.roomType}` : ""}`}
                    </Text>
                  </View>
                  <Badge
                    label={`${leader.joinedCount} joined`}
                    tone="success"
                  />
                </View>
              ))}
            </Card>
          </View>
        ) : null}
      </View>

      {/* ------------------------------------------------------------------ */}
      <Sheet
        footer={
          open?.status === "INQUIRY_CREATED" ? (
            <Button
              label="They joined"
              loading={busy}
              onPress={() => void confirm()}
            />
          ) : (
            <Button
              label="Save the reward"
              loading={busy}
              onPress={() => void saveReward()}
            />
          )
        }
        onClose={() => setOpen(null)}
        open={open !== null}
        title={open?.name ?? ""}
      >
        {open ? (
          <View className="gap-3 pb-2">
            <Text variant="caption">
              {open.status === "INQUIRY_CREATED"
                ? `Confirming says ${open.name} actually moved in, and opens a reward for ${open.referrerName || "the referrer"}.`
                : `Referred by ${open.referrerName || "a resident"}. A reward marked paid also marks the referral rewarded.`}
            </Text>

            <Select
              label="Reward"
              onChange={setRewardType}
              options={REWARD_TYPES}
              value={rewardType}
            />

            <Input
              hint="Leave at zero for a thank-you with no payout."
              keyboardType="number-pad"
              label="Amount (NPR)"
              onChangeText={setAmount}
              value={amount}
            />

            <Input
              label="Note"
              multiline
              onChangeText={setNotes}
              placeholder="Taken off next month's rent"
              style={{ height: 80 }}
              value={notes}
            />

            {open.status === "INQUIRY_CREATED" ? null : (
              <Select
                label="Payout state"
                onChange={setRewardStatus}
                options={REWARD_STATUSES}
                value={rewardStatus}
              />
            )}

            {open.referrerPhone ? (
              <Chip
                icon="call-outline"
                label={`Call ${open.referrerName || "the referrer"}`}
                onPress={() =>
                  void Linking.openURL(`tel:${open.referrerPhone}`)
                }
                tone="brand"
              />
            ) : null}
          </View>
        ) : null}
      </Sheet>
    </Screen>
  );
}
