import { Image } from "expo-image";
import { router } from "expo-router";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { NotificationBell } from "@/components/notification-bell";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { FactRow, Grid, StatTile } from "@/components/ui/layout";
import { CardRow } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { SkeletonRows, SkeletonTiles } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";
import { useAppSelector } from "@/hooks/redux";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { readApiError } from "@/lib/api-contract";
import { openAssetViewer } from "@/lib/asset-viewer";
import { fileAssetUrl } from "@/lib/finance-api";
import { formatMoney } from "@/lib/format";
import {
  checkFieldCash,
  type FieldCash,
  getPlanLedger,
  listFieldCash,
  listPlanClaims,
  type PlanClaim,
  reviewPlanClaim,
} from "@/lib/platform-admin-api";
import { invalidateQuery } from "@/lib/query-cache";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Money — what hostels owe us and what is waiting on a human: QR payment
 * proofs (web `SubscriptionClaimQueue`: the screenshot on the card, one press to
 * confirm, a refusal note in place) and field cash Softmato has not confirmed
 * yet, then the full plan ledger and supply store orders.
 */

export default function PlatformMoneyScreen() {
  const ledger = useResource(getPlanLedger, { cacheKey: "platform:plan-ledger" });
  const claims = useResource(listPlanClaims, { cacheKey: "platform:plan-claims" });
  const cash = useResource(listFieldCash, { cacheKey: "platform:field-cash" });
  const totals = ledger.data?.totals;

  const refresh = () => [ledger, claims, cash].forEach((resource) => resource.refresh());
  const reviewed = () => {
    claims.refresh();
    ledger.refresh();
    invalidateQuery("platform:plan-claims");
  };

  return (
    <Screen
      header={<AppBar accent actions={<NotificationBell tone="onAccent" />} large title="Money" />}
      insideTabs
      onRefresh={refresh}
      refreshing={ledger.refreshing || claims.refreshing}
      scroll
    >
      <View className="gap-5 pt-4">
        {ledger.loading ? (
          <SkeletonTiles columns={2} />
        ) : totals ? (
          <Grid maxColumns={2}>
            {[
              <StatTile icon="cash" key="in" label="Collected" tone="success" value={formatMoney(totals.collected)} />,
              <StatTile icon="alert-circle" key="out" label="Outstanding" tone={totals.outstanding > 0 ? "warning" : "success"} value={formatMoney(totals.outstanding)} />,
              <StatTile icon="receipt" key="billed" label="Billed" value={formatMoney(totals.billed)} />,
              <StatTile icon="hostel" key="plans" label="Active plans" value={String(totals.activePlans)} />,
            ]}
          </Grid>
        ) : (
          <Card>
            <Text variant="muted">{ledger.error ?? "Plan billing could not be loaded."}</Text>
          </Card>
        )}

        <View>
          <SectionHeader subtitle="Confirming records the payment, issues the receipt and clears the due" title={`Payment proofs${claims.data?.length ? ` · ${claims.data.length}` : ""}`} />
          {claims.loading ? (
            <SkeletonRows rows={2} />
          ) : !claims.data?.length ? (
            <Card>
              <Text variant="muted">{claims.error ?? "No hostel is waiting on a payment check."}</Text>
            </Card>
          ) : (
            <View className="gap-3">
              {claims.data.map((claim) => (
                <ClaimCard claim={claim} key={claim.id} onReviewed={reviewed} />
              ))}
            </View>
          )}
        </View>

        {cash.data?.length ? (
          <View>
            <SectionHeader subtitle="Filed by the field team, waiting on Softmato" title={`Field cash · ${cash.data.length}`} />
            <View className="gap-3">
              {cash.data.map((row) => (
                <CashCard key={row.id} onChecked={cash.refresh} row={row} />
              ))}
            </View>
          </View>
        ) : null}

        <View className="gap-3">
          <CardRow icon="receipt" onPress={() => router.push("/manage/platform/plan-billing")} subtitle="Every plan invoice and payment" title="Plan billing" />
          <CardRow icon="cart" onPress={() => router.push("/manage/platform/store-orders")} subtitle="Confirm, pack, ship, deliver" title="Store orders" />
        </View>
      </View>
    </Screen>
  );
}

function ClaimCard({ claim, onReviewed }: { claim: PlanClaim; onReviewed: () => void }) {
  const dates = useDates();
  const token = useAppSelector((state) => state.auth.accessToken);
  const [busy, setBusy] = useState(false);
  const [refusing, setRefusing] = useState(false);
  const [note, setNote] = useState("");

  async function review(approve: boolean) {
    setBusy(true);
    try {
      await reviewPlanClaim(claim.id, approve, note);
      toastSuccess(approve ? `Payment confirmed for ${claim.hostelName}` : `Refused — ${claim.hostelName} is told by email`);
      onReviewed();
    } catch (error) {
      toastError("That did not go through", readApiError(error));
      setBusy(false);
    }
  }

  return (
    <Card className="gap-3">
      <View className="flex-row items-start justify-between gap-3">
        <View className="min-w-0 flex-1">
          <Text className="text-base font-bold" numberOfLines={1}>
            {claim.hostelName}
          </Text>
          <Text numberOfLines={1} variant="muted">
            {claim.planName} · {claim.invoiceNumber}
          </Text>
        </View>
        <Text className="font-amount tabular-nums" variant="title">{formatMoney(claim.amount)}</Text>
      </View>

      {claim.proofAssetId ? (
        <Pressable
          accessibilityHint="Opens the screenshot full screen"
          accessibilityLabel="Payment screenshot"
          accessibilityRole="imagebutton"
          className="overflow-hidden rounded-xl border border-border active:opacity-80"
          onPress={() => openAssetViewer([{ assetId: claim.proofAssetId!, title: claim.hostelName }])}
        >
          <Image
            cachePolicy="memory-disk"
            contentFit="cover"
            source={{ headers: token ? { Authorization: `Bearer ${token}` } : undefined, uri: fileAssetUrl(claim.proofAssetId) }}
            style={{ height: 220, width: "100%" }}
          />
        </Pressable>
      ) : (
        <View className="rounded-xl bg-warning-soft px-3 py-2">
          <Text className="text-sm text-warning">No screenshot attached.</Text>
        </View>
      )}

      <View>
        {claim.reference ? <FactRow label="Reference" value={claim.reference} /> : null}
        <FactRow label="Sent" value={claim.claimedAt ? dates.ago(claim.claimedAt) : "just now"} />
        {claim.note ? <FactRow label="Their note" value={claim.note} /> : null}
      </View>

      {refusing ? (
        <Input
          label="Why (they read this)"
          maxLength={500}
          multiline
          onChangeText={setNote}
          placeholder="e.g. The amount does not match the invoice"
          value={note}
        />
      ) : null}

      <View className="flex-row gap-3">
        <View className="flex-1">
          {refusing ? (
            <Button disabled={busy} label="Send refusal" onPress={() => void review(false)} variant="danger" />
          ) : (
            <Button disabled={busy} label="Refuse" onPress={() => setRefusing(true)} variant="outline" />
          )}
        </View>
        <View className="flex-1">
          {refusing ? (
            <Button disabled={busy} label="Back" onPress={() => setRefusing(false)} variant="ghost" />
          ) : (
            <Button disabled={busy} label="Confirm payment" loading={busy} onPress={() => void review(true)} />
          )}
        </View>
      </View>
    </Card>
  );
}

function CashCard({ onChecked, row }: { onChecked: () => void; row: FieldCash }) {
  const dates = useDates();
  const [busy, setBusy] = useState(false);

  async function check() {
    setBusy(true);
    try {
      await checkFieldCash(row.id);
      toastSuccess("Checked with Softmato");
      onChecked();
    } catch (error) {
      toastError("Could not check", readApiError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="gap-2">
      <View className="flex-row items-start justify-between gap-3">
        <View className="min-w-0 flex-1">
          <Text className="font-semibold" numberOfLines={1}>
            {row.hostelName}
          </Text>
          <Text numberOfLines={1} variant="muted">
            {row.collectedBy} · {dates.ago(row.collectedAt)}
          </Text>
        </View>
        <Text className="font-amount tabular-nums font-bold">{formatMoney(row.amount)}</Text>
      </View>
      <FactRow label="Invoice" value={row.invoiceNumber} />
      <FactRow label="Softmato no." value={row.transactionNo ?? "Not filed yet"} />
      <Button disabled={busy} label="Check now" loading={busy} onPress={() => void check()} size="sm" variant="outline" />
    </Card>
  );
}
