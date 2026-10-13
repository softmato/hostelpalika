import { router } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Pressable, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RowDivider } from "@/components/ui/list-row";
import { Money } from "@/components/ui/money";
import { Sheet } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";
import { readApiError } from "@/lib/api-contract";
import { formatMoney } from "@/lib/format";
import { dayInputFromNow, parseDayInput } from "@/lib/manage-dates";
import {
  addResidentLeave,
  getResidentLeaves,
  removeResidentLeave,
  type ResidentLeaves,
} from "@/lib/money-rules-api";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Days a resident was away and what came off their bill for it
 * (docs/FIELD_FIXES_2026_10.md §9). The hostel's rule decides the money; this
 * only takes the days.
 */
export function DaysAwaySheet({
  name,
  onChanged,
  onClose,
  open,
  residentId,
}: {
  name: string;
  onChanged: () => void;
  onClose: () => void;
  open: boolean;
  residentId: string;
}) {
  const [data, setData] = useState<ResidentLeaves | null>(null);
  const [from, setFrom] = useState(() => dayInputFromNow(0));
  const [to, setTo] = useState(() => dayInputFromNow(0));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;

    let live = true;

    getResidentLeaves(residentId)
      .then((result) => live && setData(result))
      .catch((error) => live && toastError("Could not load", readApiError(error)));

    return () => {
      live = false;
    };
  }, [open, residentId]);

  const run = useCallback(
    async (work: () => Promise<ResidentLeaves>, done: string) => {
      setBusy(true);
      try {
        setData(await work());
        toastSuccess(done);
        setNote("");
        onChanged();
      } catch (error) {
        toastError("Not saved", readApiError(error));
      } finally {
        setBusy(false);
      }
    },
    [onChanged],
  );

  const rule = data?.rule;
  const valid = Boolean(parseDayInput(from) && parseDayInput(to));

  return (
    <Sheet
      footer={
        rule?.enabled ? (
          <Button
            disabled={!valid}
            label="Add days away"
            loading={busy}
            onPress={() => void run(() => addResidentLeave(residentId, { from, note: note.trim() || undefined, to }), "Days away added")}
          />
        ) : undefined
      }
      onClose={onClose}
      open={open}
      tall
      title={`Days away · ${name}`}
    >
      {!data ? (
        <Skeleton height={120} radius={16} />
      ) : !rule?.enabled ? (
        <View className="gap-3">
          <Text variant="muted">Your hostel gives no money off for days away.</Text>
          <Button
            label="Set it in Money rules"
            onPress={() => {
              onClose();
              router.push("/manage/finance/money-rules");
            }}
            variant="outline"
          />
        </View>
      ) : (
        <View className="gap-4 pb-2">
          <Text variant="caption">
            {rule.mode === "FOOD"
              ? `${formatMoney(rule.foodPerDay)} off a day, from ${rule.minDays} days away.`
              : `A day's rent off a day, from ${rule.minDays} days away.`}
            {" Comes off that month's bill."}
          </Text>

          {data.leaves.length > 0 ? (
            <View className="rounded-2xl border border-border bg-card px-3">
              {data.leaves.map((leave, index) => (
                <View key={leave.id}>
                  {index > 0 ? <RowDivider /> : null}
                  <View className="flex-row items-center gap-3 py-3">
                    <View className="flex-1 gap-0.5">
                      <Text variant="label">{`${leave.label} · ${leave.days} days`}</Text>
                      {leave.note ? <Text variant="caption">{leave.note}</Text> : null}
                    </View>
                    <Money tone="credit" value={leave.amount} />
                    <Pressable
                      accessibilityLabel="Remove these days"
                      accessibilityRole="button"
                      hitSlop={8}
                      onPress={() => void run(() => removeResidentLeave(residentId, leave.id), "Removed")}
                    >
                      <Text className="text-sm font-semibold text-destructive">Remove</Text>
                    </Pressable>
                  </View>
                </View>
              ))}
            </View>
          ) : null}

          <View className="flex-row gap-3">
            <View className="flex-1">
              <Input keyboardType="numbers-and-punctuation" label="From" onChangeText={setFrom} placeholder="YYYY-MM-DD" value={from} />
            </View>
            <View className="flex-1">
              <Input keyboardType="numbers-and-punctuation" label="To" onChangeText={setTo} placeholder="YYYY-MM-DD" value={to} />
            </View>
          </View>
          <Input label="Note (optional)" onChangeText={setNote} placeholder="Went home for Dashain" value={note} />
        </View>
      )}
    </Sheet>
  );
}
