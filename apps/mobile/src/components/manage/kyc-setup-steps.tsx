import { useState } from "react";
import { View } from "react-native";

import { AddRoomsSheet } from "@/components/manage/add-rooms-sheet";
import { useKycDraft } from "@/components/manage/kyc-draft";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { FactRow } from "@/components/ui/layout";
import { RowDivider } from "@/components/ui/list-row";
import { SkeletonCard } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useResource } from "@/hooks/use-resource";
import { readApiError } from "@/lib/api-contract";
import { formatDateIn } from "@/lib/calendar";
import { dayInputFromNow, startOfDayIso } from "@/lib/manage-dates";
import { type MoneyRules, moneyRulesQuery, saveMoneyRules } from "@/lib/money-rules-api";
import { addRooms, byFloor, floorLabel, type RoomLayout, roomsQuery } from "@/lib/rooms-api";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * KYC step: each floor's rooms with their numbers (docs/FIELD_FIXES_2026_10.md
 * §5). Adding saves at once, like photos; done when any room exists.
 */
export function KycRoomsStep({ onSaved }: { onSaved: () => Promise<void> | void }) {
  const query = roomsQuery.layout();
  const layout = useResource<RoomLayout>(query.load, { cacheKey: query.key, topics: query.topics });
  const [adding, setAdding] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useKycDraft({ busy, dirty: false, save: async () => true });

  if (layout.loading) return <SkeletonCard rows={3} />;
  if (layout.error || !layout.data) {
    return <ErrorState message={layout.error ?? "Could not load your rooms."} onRetry={layout.reload} />;
  }

  const data = layout.data;
  const floors = byFloor(data.rooms);

  if (!data.tracking) {
    return (
      <Card>
        <Text variant="muted">You keep residents by room type only. Turn on Floor & room in Rooms to number them.</Text>
      </Card>
    );
  }

  return (
    <View className="gap-4">
      {floors.length === 0 ? (
        <Card>
          <Text variant="muted">Add each floor and its room numbers. Every resident then gets a floor and a room.</Text>
        </Card>
      ) : (
        <Card className="py-1">
          {floors.map((entry, index) => (
            <View key={entry.floor}>
              {index > 0 ? <RowDivider /> : null}
              <FactRow
                label={floorLabel(entry.floor)}
                value={`${entry.rooms.length} rooms · ${entry.rooms.map((room) => room.number).slice(0, 4).join(", ")}${entry.rooms.length > 4 ? "…" : ""}`}
              />
            </View>
          ))}
        </Card>
      )}

      <Button
        label={floors.length === 0 ? "Add the first floor" : "Add rooms"}
        onPress={() => setAdding(floors.at(-1) ? floors.at(-1)!.floor + 1 : 0)}
        variant={floors.length === 0 ? "primary" : "outline"}
      />

      <AddRoomsSheet
        busy={busy}
        floor={adding}
        onClose={() => setAdding(null)}
        onSave={async (input) => {
          setBusy(true);
          try {
            await addRooms(input);
            toastSuccess(`${input.numbers.length} rooms added`);
            setAdding(null);
            await Promise.all([layout.refresh(), onSaved()]);
          } catch (error) {
            toastError("Not added", readApiError(error));
          } finally {
            setBusy(false);
          }
        }}
        roomTypes={data.roomTypes}
      />
    </View>
  );
}

/**
 * KYC step: the bank's closing balance the day they start with us, so the
 * app's statement balance matches the bank (docs/FIELD_FIXES_2026_10.md §4).
 */
export function KycOpeningStep({ onSaved }: { onSaved: () => Promise<void> | void }) {
  const query = moneyRulesQuery();
  const rules = useResource<MoneyRules>(query.load, { cacheKey: query.key, topics: query.topics });

  if (rules.loading) return <SkeletonCard rows={2} />;
  if (rules.error || !rules.data) {
    return <ErrorState message={rules.error ?? "Could not load."} onRetry={rules.reload} />;
  }

  return <OpeningBalanceForm onSaved={onSaved} saved={rules.data.openingBalance} />;
}

/** Amount + day. In KYC the wizard's button saves it; elsewhere it has its own. */
export function OpeningBalanceForm({
  onSaved,
  saved,
  standalone = false,
}: {
  onSaved: () => Promise<void> | void;
  saved: MoneyRules["openingBalance"];
  standalone?: boolean;
}) {
  const [amount, setAmount] = useState(saved ? String(saved.amount) : "");
  const [asOf, setAsOf] = useState(saved?.asOf ?? dayInputFromNow(0));
  const [busy, setBusy] = useState(false);

  const rupees = Number(amount.replace(/[^\d-]/g, ""));
  const validDay = Boolean(startOfDayIso(asOf));
  const valid = amount.trim() !== "" && Number.isFinite(rupees) && validDay;
  const dirty = amount !== (saved ? String(saved.amount) : "") || asOf !== (saved?.asOf ?? dayInputFromNow(0));

  const save = async () => {
    if (!valid) {
      toastError("Check the amount and day", "Type the bank balance, and the day as YYYY-MM-DD.");
      return false;
    }

    setBusy(true);
    try {
      await saveMoneyRules({ openingBalance: { amount: rupees, asOf } });
      await onSaved();
      return true;
    } catch (error) {
      toastError("Not saved", readApiError(error));
      return false;
    } finally {
      setBusy(false);
    }
  };

  useKycDraft({ busy, dirty: !standalone && dirty, save });

  return (
    <View className="gap-4">
      <Input
        hint="What your bank account showed at the end of that day. Use minus for an overdraft."
        keyboardType="numbers-and-punctuation"
        label="Bank balance (Rs)"
        onChangeText={setAmount}
        placeholder="250000"
        value={amount}
      />
      <Input
        hint={validDay ? formatDateIn("BS", startOfDayIso(asOf) as string) : "Write the day as YYYY-MM-DD"}
        keyboardType="numbers-and-punctuation"
        label="On the day"
        onChangeText={setAsOf}
        value={asOf}
      />
      <Text variant="caption">Your statement starts from this, so the balance in the app matches your bank.</Text>
      {standalone ? (
        <Button
          disabled={!dirty || !valid}
          label="Save"
          loading={busy}
          onPress={() => void save().then((ok) => ok && toastSuccess("Opening balance saved"))}
        />
      ) : null}
    </View>
  );
}
