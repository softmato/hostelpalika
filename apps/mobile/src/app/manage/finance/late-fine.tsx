import { type ReactNode, useState } from "react";
import { View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Chip, FactRow } from "@/components/ui/layout";
import { ListRow } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Segmented } from "@/components/ui/segmented";
import { SkeletonCard } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { Toggle } from "@/components/ui/toggle";
import { useResource } from "@/hooks/use-resource";
import { readApiError } from "@/lib/api-contract";
import { formatMoney } from "@/lib/format";
import { khataQuery, type LateFine, type LateFineMode, saveLateFine } from "@/lib/khata-api";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Late fine — on/off, Rs or % a day, and the fine-free days.
 *
 * Bills go out on the 1st; with the fine on they fall due on day `graceDays`
 * and every unpaid day after adds the fine to the bill (see
 * `late-fine.service`). The example card does the arithmetic for them, so the
 * screen needs no paragraph explaining it.
 */

const QUICK = {
  PER_DAY_AMOUNT: [20, 50, 100],
  PER_DAY_PERCENT: [0.5, 1, 2],
} as const;

const FREE_DAYS = [3, 5, 7, 10];

/** The bill the example card fines. A round, typical rent. */
const EXAMPLE_BILL = 8000;
const EXAMPLE_DAYS = 3;

export default function LateFineScreen() {
  const query = khataQuery.lateFine();
  const fine = useResource(query.load, { cacheKey: query.key, topics: query.topics });
  const header = <AppBar accent centerTitle showBack title="Late fine" />;

  if (fine.loading) {
    return (
      <Screen header={header}>
        <SkeletonCard rows={3} />
      </Screen>
    );
  }

  if (fine.error || !fine.data) {
    return (
      <Screen header={header}>
        <ErrorState message={fine.error ?? "Could not load"} onRetry={fine.reload} />
      </Screen>
    );
  }

  return (
    <LateFineForm header={header} initial={fine.data} onSaved={(saved) => fine.setData(() => saved)} />
  );
}

/** Seeded once from the server, so a background revalidate never undoes an edit. */
function LateFineForm({
  header,
  initial,
  onSaved,
}: {
  header: ReactNode;
  initial: LateFine;
  onSaved: (saved: LateFine) => void;
}) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [mode, setMode] = useState<LateFineMode>(initial.mode);
  const [rate, setRate] = useState(initial.rate > 0 ? String(initial.rate) : "");
  const [graceDays, setGraceDays] = useState(initial.graceDays);
  const [saving, setSaving] = useState(false);

  const rateNumber = Number(rate);
  const perDay =
    mode === "PER_DAY_AMOUNT" ? Math.round(rateNumber) : Math.round((EXAMPLE_BILL * rateNumber) / 100);

  const save = async () => {
    if (enabled && !(rateNumber > 0)) {
      toastError("Add the fine", mode === "PER_DAY_AMOUNT" ? "Rupees a day." : "Percent a day.");
      return;
    }

    setSaving(true);

    try {
      const saved = await saveLateFine({
        enabled,
        graceDays,
        mode,
        rate: enabled ? rateNumber : initial.rate,
      });

      onSaved(saved);
      toastSuccess(enabled ? "Late fine is on" : "Late fine is off");
    } catch (error) {
      toastError("Could not save", readApiError(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen
      footer={<Button label="Save" loading={saving} onPress={() => void save()} />}
      header={header}
      scroll
    >
      <View className="gap-5 pt-1">
        <Card padding="px-4 py-1">
          <ListRow
            icon="alarm-outline"
            iconBgColor="#FF3B30"
            right={
              <Toggle accessibilityLabel="Charge a late fine" onChange={setEnabled} value={enabled} />
            }
            subtitle={enabled ? "Unpaid bills get a fine every day" : "Off"}
            title="Charge a late fine"
          />
        </Card>

        {enabled ? (
          <>
            <View className="gap-3">
              <SectionHeader title="Fine" />
              <Segmented
                onChange={(next) => {
                  setMode(next);
                  setRate("");
                }}
                options={[
                  { label: "Rs a day", value: "PER_DAY_AMOUNT" },
                  { label: "% a day", value: "PER_DAY_PERCENT" },
                ]}
                value={mode}
              />
              <Input
                keyboardType="decimal-pad"
                leading={<Text variant="subtitle">{mode === "PER_DAY_AMOUNT" ? "Rs" : "%"}</Text>}
                onChangeText={(text) => setRate(text.replace(/[^\d.]/g, ""))}
                placeholder="0"
                style={{ fontSize: 22, fontWeight: "700" }}
                value={rate}
              />
              <View className="flex-row flex-wrap gap-2">
                {QUICK[mode].map((value) => (
                  <Chip
                    key={value}
                    label={mode === "PER_DAY_AMOUNT" ? formatMoney(value) : `${value}%`}
                    onPress={() => setRate(String(value))}
                    tone={rate === String(value) ? "brand" : "neutral"}
                  />
                ))}
              </View>
            </View>

            <View className="gap-3">
              <SectionHeader title="Free days" />
              <View className="flex-row flex-wrap gap-2">
                {FREE_DAYS.map((days) => (
                  <Chip
                    icon="calendar-outline"
                    key={days}
                    label={`${days} days`}
                    onPress={() => setGraceDays(days)}
                    tone={graceDays === days ? "brand" : "neutral"}
                  />
                ))}
              </View>
            </View>

            <View>
              <SectionHeader title="Example" />
              <Card className="gap-1">
                <FactRow label="Bill" value={formatMoney(EXAMPLE_BILL)} />
                <FactRow label="Pay without fine" value={`Day 1 – ${graceDays}`} />
                <FactRow label="Fine starts" value={`Day ${graceDays + 1}`} />
                <FactRow
                  label={`Paid ${EXAMPLE_DAYS} days late`}
                  value={perDay > 0 ? `+ ${formatMoney(perDay * EXAMPLE_DAYS)}` : "—"}
                />
              </Card>
            </View>
          </>
        ) : null}
      </View>
    </Screen>
  );
}
