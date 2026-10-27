import { useState } from "react";
import { View } from "react-native";

import { OpeningBalanceForm } from "@/components/manage/kyc-setup-steps";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ListRow } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Segmented } from "@/components/ui/segmented";
import { SkeletonCard } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { Toggle } from "@/components/ui/toggle";
import { useResource } from "@/hooks/use-resource";
import { readApiError } from "@/lib/api-contract";
import { type LeaveRule, type MoneyRules, moneyRulesQuery, saveMoneyRules } from "@/lib/money-rules-api";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Three money rules set once (docs/FIELD_FIXES_2026_10.md): where the
 * statement starts, how a leaving month is charged, and what days away take
 * off. Each section saves on its own.
 */
export default function MoneyRulesScreen() {
  const query = moneyRulesQuery();
  const rules = useResource<MoneyRules>(query.load, { cacheKey: query.key, topics: query.topics });
  const header = <AppBar accent centerTitle showBack title="Money rules" />;

  if (rules.loading) {
    return (
      <Screen header={header}>
        <View className="gap-4 pt-1">
          <SkeletonCard rows={2} />
          <SkeletonCard rows={3} />
        </View>
      </Screen>
    );
  }

  if (rules.error || !rules.data) {
    return (
      <Screen header={header}>
        <ErrorState message={rules.error ?? "Could not load"} onRetry={rules.reload} />
      </Screen>
    );
  }

  const data = rules.data;

  return (
    <Screen header={header} onRefresh={rules.refresh} refreshing={rules.refreshing} scroll>
      <View className="gap-6 pt-1">
        <View>
          <SectionHeader subtitle="The statement starts from it" title="Opening balance" />
          <Card>
            <OpeningBalanceForm onSaved={() => rules.refresh()} saved={data.openingBalance} standalone />
          </Card>
        </View>

        <View>
          <SectionHeader subtitle="What the move-out sheet starts on" title="Leaving month" />
          <Card className="gap-3">
            <Segmented
              onChange={(moveOutCharge) =>
                void saveMoneyRules({ moveOutCharge })
                  .then(() => rules.refresh())
                  .catch((error) => toastError("Not saved", readApiError(error)))
              }
              options={[
                { label: "Full month", value: "FULL_MONTH" },
                { label: "Till the day", value: "TILL_DAY" },
              ]}
              value={data.moveOutCharge}
            />
            <Text variant="caption">
              {data.moveOutCharge === "FULL_MONTH"
                ? "Leaving on the 10th still pays the whole month."
                : "Leaving on the 10th pays 10 days."}{" "}
              It can be changed for each person when they leave.
            </Text>
          </Card>
        </View>

        <NoticeDays onSaved={() => rules.refresh()} saved={data.moveOutNoticeDays ?? 0} />

        <DaysAway onSaved={() => rules.refresh()} saved={data.leave} />
      </View>
    </Screen>
  );
}

/** How far ahead a resident's leaving day must be (E5). */
function NoticeDays({ onSaved, saved }: { onSaved: () => Promise<void> | void; saved: number }) {
  const [days, setDays] = useState(String(saved));
  const [busy, setBusy] = useState(false);
  const value = Number.parseInt(days, 10);
  const valid = Number.isInteger(value) && value >= 0 && value <= 90;

  return (
    <View>
      <SectionHeader subtitle="Residents give notice in the app" title="Move-out notice" />
      <Card className="gap-3">
        <Input
          hint={valid ? `A resident can pick a leaving day ${value} or more days from today.` : "0 to 90 days."}
          keyboardType="number-pad"
          label="Notice days"
          onChangeText={setDays}
          value={days}
        />
        <Button
          disabled={!valid || value === saved}
          label="Save"
          loading={busy}
          onPress={() => {
            setBusy(true);
            void saveMoneyRules({ moveOutNoticeDays: value })
              .then(async () => {
                toastSuccess("Notice days saved");
                await onSaved();
              })
              .catch((error) => toastError("Not saved", readApiError(error)))
              .finally(() => setBusy(false));
          }}
          variant="secondary"
        />
      </Card>
    </View>
  );
}

function DaysAway({ onSaved, saved }: { onSaved: () => Promise<void> | void; saved: LeaveRule }) {
  const [rule, setRule] = useState(saved);
  const [food, setFood] = useState(String(saved.foodPerDay || ""));
  const [minDays, setMinDays] = useState(String(saved.minDays));
  const [busy, setBusy] = useState(false);

  const next: LeaveRule = { ...rule, foodPerDay: Number(food) || 0, minDays: Math.max(1, Number(minDays) || 1) };
  const dirty = JSON.stringify(next) !== JSON.stringify(saved);

  const save = async () => {
    if (next.enabled && next.mode === "FOOD" && next.foodPerDay <= 0) {
      toastError("How much a day?", "Type the food cost of one day.");
      return;
    }

    setBusy(true);
    try {
      await saveMoneyRules({ leave: next });
      toastSuccess("Days away saved");
      await onSaved();
    } catch (error) {
      toastError("Not saved", readApiError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View>
      <SectionHeader subtitle="Home for a festival, a holiday" title="Days away" />
      <Card className="gap-4">
        <ListRow
          right={
            <Toggle
              accessibilityLabel="Give money off for days away"
              onChange={(enabled) => setRule((current) => ({ ...current, enabled }))}
              value={rule.enabled}
            />
          }
          subtitle={rule.enabled ? "Staff add the days on the resident's page" : "No money off for days away"}
          title="Money off for days away"
        />

        {rule.enabled ? (
          <>
            <Segmented
              onChange={(mode) => setRule((current) => ({ ...current, mode }))}
              options={[
                { label: "Food only", value: "FOOD" },
                { label: "Full day", value: "FULL_DAY" },
              ]}
              value={rule.mode}
            />
            {rule.mode === "FOOD" ? (
              <Input keyboardType="number-pad" label="Food a day (Rs)" onChangeText={setFood} placeholder="150" value={food} />
            ) : (
              <Text variant="caption">A day of their own rent comes off for each day away.</Text>
            )}
            <Input
              hint="Shorter stays away get nothing."
              keyboardType="number-pad"
              label="At least (days)"
              onChangeText={setMinDays}
              value={minDays}
            />
          </>
        ) : null}

        <Button disabled={!dirty} label="Save" loading={busy} onPress={() => void save()} />
      </Card>
    </View>
  );
}
