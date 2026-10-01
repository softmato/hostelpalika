import { router } from "expo-router";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { Avatar } from "@/components/ui/avatar";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Chip, FactRow } from "@/components/ui/layout";
import { CardRow } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonRows } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppSelector } from "@/hooks/redux";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { adminQuery } from "@/lib/admin-queries";
import { residentCardPhotoSource } from "@/lib/admin-scan-api";
import { readApiError } from "@/lib/api-contract";
import { openConfirm } from "@/lib/confirm";
import { formatMoney } from "@/lib/format";
import {
  addJoinRequest,
  type JoinRequest,
  type JoinRequests,
  sendBackJoinRequest,
} from "@/lib/join-api";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Residents → Join requests (docs/EXISTING_RESIDENTS.md, "Join link").
 *
 * People who sent their room and rent through the join link. Each is checked
 * the way the scan desk checks a card — their ID card photo beside what they
 * said and the bill it will make — then Add (after "are you sure") or Send back
 * with what to fix. Tapping the face opens the whole card.
 */

const SEND_BACK_REASONS = [
  "Room type is not right",
  "Rent paid / months due is not right",
  "Deposit is not right",
  "Part paid amount is not right",
];

export default function JoinRequestsScreen() {
  const query = adminQuery.joinRequests();
  const list = useResource<JoinRequests>(query.load, { cacheKey: query.key, topics: query.topics });
  const [sendingBack, setSendingBack] = useState<JoinRequest | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const header = (
    <AppBar
      showBack
      subtitle={list.data ? `${list.data.waiting} waiting` : undefined}
      title="Join requests"
    />
  );

  if (list.loading) {
    return (
      <Screen header={header} scroll>
        <SkeletonRows rows={4} />
      </Screen>
    );
  }

  if (list.error || !list.data) {
    return (
      <Screen header={header}>
        <ErrorState message={list.error ?? "Join requests could not be loaded."} onRetry={list.reload} />
      </Screen>
    );
  }

  const requests = list.data.requests;
  const waiting = requests.filter((request) => request.status === "PENDING");
  const returned = requests.filter((request) => request.status === "REJECTED");
  const added = requests.filter((request) => request.status === "ADDED");

  function add(request: JoinRequest) {
    const due = request.bills?.total ?? 0;

    openConfirm({
      confirmLabel: "Yes, add",
      message: [
        `${request.roomType} · ${request.rentLabel}.`,
        due > 0 ? `Bills of ${formatMoney(due)} are made now.` : "Nothing is billed now.",
        "They are told by email and in the app.",
      ].join(" "),
      onConfirm: async () => {
        try {
          await addJoinRequest(request.id);
          toastSuccess(`${request.fullName} added`);
          list.refresh();
        } catch (error) {
          toastError("Not added", readApiError(error));
        }
      },
      title: `Add ${request.fullName}?`,
    });
  }

  async function sendBack() {
    if (!sendingBack) return;

    setBusy(true);

    try {
      await sendBackJoinRequest(sendingBack.id, reason.trim());
      toastSuccess(`Sent back to ${sendingBack.fullName}`);
      setSendingBack(null);
      setReason("");
      list.refresh();
    } catch (error) {
      toastError("Could not send it back", readApiError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen header={header} onRefresh={list.refresh} refreshing={list.refreshing} scroll>
      <View className="gap-5">
        <CardRow
          icon="link-outline"
          onPress={() => router.push("/manage/join-link")}
          subtitle="Share it on WhatsApp, or show the QR"
          title="Join link"
        />

        {requests.length === 0 ? (
          <EmptyCard
            description="When a resident sends their room and rent through your join link, it shows here."
            title="No requests yet"
          />
        ) : null}

        {waiting.length ? (
          <View>
            <SectionHeader subtitle="Check against your book, then add" title={`Waiting · ${waiting.length}`} />
            <View className="gap-3">
              {waiting.map((request) => (
                <RequestCard
                  key={request.id}
                  onAdd={() => add(request)}
                  onSendBack={() => {
                    setReason("");
                    setSendingBack(request);
                  }}
                  request={request}
                />
              ))}
            </View>
          </View>
        ) : null}

        {returned.length ? (
          <View>
            <SectionHeader subtitle="They fix it on the same link" title="Sent back" />
            <View className="gap-3">
              {returned.map((request) => (
                <CardRow
                  icon="arrow-undo-outline"
                  key={request.id}
                  subtitle={request.rejectReason}
                  title={request.fullName}
                  tone="warning"
                />
              ))}
            </View>
          </View>
        ) : null}

        {added.length ? (
          <View>
            <SectionHeader title="Added lately" />
            <View className="gap-3">
              {added.map((request) => (
                <CardRow
                  icon="checkmark-circle-outline"
                  key={request.id}
                  onPress={
                    request.residentId
                      ? () => router.push(`/manage/resident/${request.residentId}`)
                      : undefined
                  }
                  subtitle={`${request.roomType} · ${request.rentLabel}`}
                  title={request.fullName}
                  tone="success"
                />
              ))}
            </View>
          </View>
        ) : null}
      </View>

      <Sheet
        footer={
          <Button
            disabled={busy || reason.trim().length < 3}
            label="Send back"
            loading={busy}
            onPress={() => void sendBack()}
          />
        }
        onClose={() => setSendingBack(null)}
        open={sendingBack !== null}
        title={sendingBack ? `Send back to ${sendingBack.fullName}` : "Send back"}
      >
        <View className="gap-4">
          <Text variant="muted">
            Say what to fix. They get a message and fix it on the same link — it stays one request.
          </Text>
          <View className="flex-row flex-wrap gap-2">
            {SEND_BACK_REASONS.map((preset) => (
              <Chip
                key={preset}
                label={preset}
                onPress={() => setReason(preset)}
                tone={reason === preset ? "brand" : "neutral"}
              />
            ))}
          </View>
          <Input
            label="What to fix"
            maxLength={300}
            multiline
            onChangeText={setReason}
            placeholder="e.g. You owe Bhadra too — choose 2 months due"
            value={reason}
          />
        </View>
      </Sheet>
    </Screen>
  );
}

function RequestCard({
  onAdd,
  onSendBack,
  request,
}: {
  onAdd: () => void;
  onSendBack: () => void;
  request: JoinRequest;
}) {
  const dates = useDates();
  const token = useAppSelector((state) => state.auth.accessToken);
  // `hasPhoto: true` — the avatar falls back to the initial when the card has none.
  const photo = residentCardPhotoSource(
    { hasPhoto: true, photoUpdatedAt: request.sentAt, residentId: request.cardId },
    token,
  );
  const bills = request.bills;

  return (
    <Card className="gap-3">
      <Pressable
        accessibilityHint="Opens their whole ID card"
        accessibilityRole="button"
        className="flex-row items-center gap-3 active:opacity-70"
        onPress={() => router.push(`/manage/scan/${encodeURIComponent(request.cardId)}`)}
      >
        <Avatar headers={photo?.headers} name={request.fullName} size="lg" uri={photo?.uri} />
        <View className="min-w-0 flex-1">
          <Text className="text-base font-bold" numberOfLines={1}>
            {request.fullName}
          </Text>
          <Text numberOfLines={1} variant="muted">
            {request.phone}
          </Text>
          <Text className="text-xs" variant="muted">
            {request.cardId} · {request.sends > 1 ? "fixed and sent again" : `sent ${dates.date(request.sentAt)}`}
          </Text>
        </View>
      </Pressable>

      <View>
        <FactRow label="Room type" value={request.roomType} />
        <FactRow label="Rent" value={request.rentLabel} />
        {request.partPaid ? <FactRow label="Part paid" value={formatMoney(request.partPaid)} /> : null}
        <FactRow label="Deposit paid" value={formatMoney(request.depositPaid)} />
        {request.joinedDate ? <FactRow label="Moved in" value={dates.date(request.joinedDate)} /> : null}
        {bills ? (
          <FactRow
            label="Bill on add"
            value={bills.total > 0 ? formatMoney(bills.total) : "Nothing — all paid"}
          />
        ) : null}
      </View>

      {request.note ? (
        <View className="rounded-xl bg-muted px-3 py-2">
          <Text className="text-sm">{request.note}</Text>
        </View>
      ) : null}

      {request.problems.length ? (
        <View className="gap-1 rounded-xl bg-warning-soft px-3 py-2">
          {request.problems.map((problem) => (
            <Text className="text-sm" key={problem}>
              {problem}
            </Text>
          ))}
        </View>
      ) : null}

      <View className="flex-row gap-3">
        <View className="flex-1">
          <Button label="Send back" onPress={onSendBack} variant="outline" />
        </View>
        <View className="flex-1">
          <Button disabled={request.problems.length > 0} label="Add" onPress={onAdd} />
        </View>
      </View>
    </Card>
  );
}
