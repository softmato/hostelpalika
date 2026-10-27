import { formatBsDate } from "@hostel/calendar/bs";
import { useCallback, useState } from "react";
import { View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { FactRow } from "@/components/ui/layout";
import { Screen } from "@/components/ui/screen";
import { SkeletonCard } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useResource } from "@/hooks/use-resource";
import { readApiError } from "@/lib/api-contract";
import { openConfirm } from "@/lib/confirm";
import {
  cancelLeavingNotice,
  getLeavingNotice,
  type LeavingNotice,
  saveLeavingNotice,
} from "@/lib/money-rules-api";
import { toastError, toastSuccess } from "@/lib/toast";

const bsLabel = (value: string) => {
  const day = new Date(`${value}T00:00:00.000Z`);

  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(day.getTime()) ? formatBsDate(day) : "";
};

/**
 * "I'm leaving" (field review E5). The resident names the day — no approval —
 * and the hostel is told at once. Rent stops on that day; they can change or
 * cancel it until then. The server holds the notice-days rule.
 */
export default function LeavingScreen() {
  const notice = useResource<LeavingNotice>(getLeavingNotice, { cacheKey: "resident:leaving" });
  const [date, setDate] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (work: () => Promise<unknown>, done: string) => {
      setBusy(true);
      try {
        await work();
        toastSuccess(done);
        setDate(null);
        setReason(null);
        await notice.refresh();
      } catch (error) {
        toastError("Not saved", readApiError(error));
      } finally {
        setBusy(false);
      }
    },
    [notice],
  );

  const header = <AppBar accent centerTitle showBack title="Moving out" />;

  if (notice.loading) {
    return (
      <Screen header={header}>
        <SkeletonCard rows={3} />
      </Screen>
    );
  }

  if (notice.error || !notice.data) {
    return (
      <Screen header={header}>
        <ErrorState message={notice.error ?? "Could not load"} onRetry={notice.reload} />
      </Screen>
    );
  }

  const data = notice.data;
  const day = date ?? data.leavingOn ?? data.earliest;
  const why = reason ?? data.reason ?? "";
  const tooSoon = day < data.earliest;

  return (
    <Screen
      footer={
        <Button
          disabled={tooSoon || !bsLabel(day)}
          label={data.leavingOn ? "Change leaving day" : "I'm leaving"}
          loading={busy}
          onPress={() => void run(() => saveLeavingNotice({ date: day, reason: why.trim() || undefined }), "The hostel has been told")}
        />
      }
      header={header}
      scroll
    >
      <View className="gap-6 pt-1">
        {data.leavingOn ? (
          <View>
            <SectionHeader title="Your notice" />
            <Card className="gap-1">
              <FactRow label="Leaving on" value={data.leavingOnLabel ?? data.leavingOn} />
              {data.reason ? <FactRow label="Reason" value={data.reason} /> : null}
              <Button
                label="Cancel — I'm staying"
                onPress={() =>
                  openConfirm({
                    confirmLabel: "I'm staying",
                    message: "Your leaving day is removed and the hostel is told.",
                    onConfirm: () => run(cancelLeavingNotice, "Notice cancelled"),
                    title: "Cancel your notice?",
                  })
                }
                variant="ghost"
              />
            </Card>
          </View>
        ) : null}

        <View>
          <SectionHeader
            subtitle={data.noticeDays > 0 ? `This hostel needs ${data.noticeDays} days' notice` : undefined}
            title={data.leavingOn ? "Pick another day" : "Your leaving day"}
          />
          <Card className="gap-3">
            <Input
              error={tooSoon ? `The earliest day is ${bsLabel(data.earliest) || data.earliest}.` : null}
              hint={bsLabel(day) || "YYYY-MM-DD"}
              keyboardType="numbers-and-punctuation"
              label="Leaving on"
              onChangeText={setDate}
              placeholder="YYYY-MM-DD"
              value={day}
            />
            <Input label="Reason" multiline onChangeText={setReason} placeholder="Optional" value={why} />
            <Text className="text-muted-foreground" variant="caption">
              Rent stops on this day. The warden moves you out on the day.
            </Text>
          </Card>
        </View>
      </View>
    </Screen>
  );
}
