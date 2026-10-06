import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useRef, useState } from "react";
import { Pressable, View } from "react-native";

import {
  AddItemButton,
  DateField,
  FormSection,
  ItemAvatar,
  ItemPicker,
  ItemSheet,
  NoStockAccess,
  QtyInput,
  readQty,
  stockChanged,
  useStock,
} from "@/components/stock/stock-parts";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Sheet, SheetRow } from "@/components/ui/sheet";
import { SkeletonCard } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { readApiError } from "@/lib/api-contract";
import { bsDayLong, newClientRequestId, todayKey } from "@/lib/expenses";
import { addStockEntry, formatQty } from "@/lib/stock-api";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Send to Building — two steps (docs/INVENTORY_PLAN.md).
 *
 * 1. **Where and what**: the other building, the day, and the items going, each
 *    with what is left here so nobody sends more than the store holds.
 * 2. **Review**: the list read back once, a note, Send Now.
 *
 * It counts at the other end only when they tap Got it.
 */

type Line = { itemId: string; qty: string };

export default function SendScreen() {
  const { colors } = useAppTheme();
  const params = useLocalSearchParams<{ itemId?: string }>();
  const { denied, here, home, overall, resource } = useStock();

  const [step, setStep] = useState<1 | 2>(1);
  const [toPick, setTo] = useState<string | null>(null);
  const [choosingTo, setChoosingTo] = useState(false);
  const [day, setDay] = useState(() => todayKey());
  const [lines, setLines] = useState<Line[]>(() => (params.itemId ? [{ itemId: params.itemId, qty: "" }] : []));
  const [note, setNote] = useState("");
  const [picking, setPicking] = useState(false);
  const [newItem, setNewItem] = useState(false);
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const requestId = useRef(newClientRequestId());

  const items = useMemo(() => (home?.items ?? []).filter((item) => item.active), [home]);
  const byId = new Map(items.map((item) => [item.id, item]));
  const shownLines = lines.filter((line) => byId.has(line.itemId));
  const others = (home?.places ?? []).filter((place) => place.id !== here?.id);
  const to = others.find((place) => place.id === toPick) ?? (others.length === 1 ? others[0] : null);

  const errorFor = (line: Line) => {
    const qty = readQty(line.qty);

    return qty === null || qty === false || qty <= 0 ? "Write how much." : null;
  };
  const firstError = !to
    ? "Pick the building it goes to."
    : shownLines.length === 0
      ? "Add at least one item."
      : shownLines.map(errorFor).find(Boolean) ?? null;

  const send = async () => {
    if (firstError || !here || !to) {
      toastError("Not sent yet", firstError ?? "Pick a building.");
      return;
    }

    setSaving(true);

    try {
      await addStockEntry({
        clientRequestId: requestId.current,
        hostelId: here.id,
        kind: "SEND",
        lines: shownLines.map((line) => ({ itemId: line.itemId, qty: readQty(line.qty) as number })),
        note: note.trim() || undefined,
        on: day,
        toHostelId: to.id,
      });
      toastSuccess(`Sent to ${to.name}`, "They tap Got it when it arrives.");
      stockChanged();
      router.back();
    } catch (error) {
      toastError("Not sent", readApiError(error, "Check your internet and tap Send again."));
    } finally {
      setSaving(false);
    }
  };

  const header = (
    <AppBar
      actions={<Text variant="label">{step}/2</Text>}
      centerTitle
      onBack={step === 2 ? () => setStep(1) : undefined}
      showBack
      subtitle={here ? `From ${here.name}` : undefined}
      title="Send to Building"
    />
  );

  if (denied) {
    return (
      <Screen header={header}>
        <NoStockAccess />
      </Screen>
    );
  }

  if (resource.error && !home) {
    return (
      <Screen header={header}>
        <ErrorState message={resource.error} onRetry={resource.reload} />
      </Screen>
    );
  }

  if (!home) {
    return (
      <Screen header={header}>
        <SkeletonCard rows={5} />
      </Screen>
    );
  }

  if (overall || !here) {
    return (
      <Screen header={header}>
        <EmptyCard description="Overall is view only. Switch to the building the goods leave from." title="Pick a building" />
      </Screen>
    );
  }

  if (others.length === 0) {
    return (
      <Screen header={header}>
        <EmptyCard description="Send works between your main hostel and its branches." title="No other building yet" />
      </Screen>
    );
  }

  return (
    <>
      <Screen
        footer={
          step === 1 ? (
            <Button
              label="Next"
              onPress={() => {
                setTried(true);

                if (firstError) {
                  toastError("Check this first", firstError);
                  return;
                }

                setStep(2);
              }}
              size="lg"
            />
          ) : (
            <Button label="Send Now" loading={saving} onPress={() => void send()} size="lg" />
          )
        }
        header={header}
        scroll
      >
        {step === 1 ? (
          <View className="gap-5 pb-4 pt-3">
            <View className="gap-1.5">
              <Text variant="caption">Send to</Text>
              <Pressable
                accessibilityRole="button"
                className={`min-h-12 flex-row items-center justify-between rounded-xl border bg-card px-3.5 active:opacity-70 ${
                  tried && !to ? "border-destructive" : "border-border"
                }`}
                onPress={() => setChoosingTo(true)}
              >
                <Text className={to ? "text-foreground" : "text-muted-foreground"} variant="body">
                  {to?.name ?? "Pick a building"}
                </Text>
                <Ionicons color={colors.mutedForeground} name="chevron-down" size={20} />
              </Pressable>
            </View>

            <DateField label="Send date" onChange={setDay} value={day} />

            <FormSection title="Items">
              <AddItemButton onPress={() => setPicking(true)} />
            </FormSection>

            {shownLines.map((line) => {
              const item = byId.get(line.itemId)!;
              const left = item.at.find((at) => at.hostelId === here.id)?.left;

              return (
                <Card className="gap-3" key={line.itemId}>
                  <View className="flex-row items-center gap-3">
                    <ItemAvatar item={item} size={36} />
                    <View className="flex-1">
                      <Text variant="label">{item.name}</Text>
                      {item.kind === "STORE" && left !== undefined ? (
                        <Text variant="caption">Left here {formatQty(left, item.unit)}</Text>
                      ) : null}
                    </View>
                    <Pressable
                      accessibilityLabel={`Remove ${item.name}`}
                      accessibilityRole="button"
                      hitSlop={8}
                      onPress={() => setLines((prev) => prev.filter((entry) => entry.itemId !== line.itemId))}
                    >
                      <Ionicons color={colors.mutedForeground} name="trash-outline" size={20} />
                    </Pressable>
                  </View>
                  <QtyInput
                    error={tried ? errorFor(line) : null}
                    label="Quantity"
                    onChangeText={(qty) =>
                      setLines((prev) => prev.map((entry) => (entry.itemId === line.itemId ? { ...entry, qty } : entry)))
                    }
                    unit={item.unit}
                    value={line.qty}
                  />
                </Card>
              );
            })}
          </View>
        ) : (
          <View className="gap-5 pb-4 pt-3">
            <Text variant="title">Review Send</Text>
            <Card className="gap-3">
              <Fact label="To" value={to?.name ?? ""} />
              <Fact label="Send date" value={bsDayLong(day)} />
            </Card>

            <View className="gap-2">
              <Text variant="subtitle">Items ({shownLines.length})</Text>
              <Card padding="px-4 py-1">
                {shownLines.map((line, index) => {
                  const item = byId.get(line.itemId)!;

                  return (
                    <View key={line.itemId}>
                      {index > 0 ? <RowDivider inset /> : null}
                      <View className="min-h-14 flex-row items-center gap-3 py-2">
                        <ItemAvatar item={item} size={32} />
                        <Text className="flex-1" variant="label">
                          {item.name}
                        </Text>
                        <Text variant="label">{formatQty(readQty(line.qty) as number, item.unit)}</Text>
                      </View>
                    </View>
                  );
                })}
              </Card>
            </View>

            <Input
              label="Note (optional)"
              maxLength={200}
              onChangeText={setNote}
              placeholder="e.g. Sent with Ram on the jeep"
              value={note}
            />
          </View>
        )}
      </Screen>

      <Sheet onClose={() => setChoosingTo(false)} open={choosingTo} title="Send to">
        <View className="gap-1 pb-2">
          {others.map((place) => (
            <SheetRow
              key={place.id}
              label={place.name}
              onPress={() => {
                setTo(place.id);
                setChoosingTo(false);
              }}
              selected={to?.id === place.id}
              subtitle={place.isMain ? "Main hostel" : "Branch"}
            />
          ))}
        </View>
      </Sheet>
      <ItemPicker
        items={items}
        onClose={() => setPicking(false)}
        onDone={(ids) => {
          setLines((prev) => [...prev, ...ids.map((itemId) => ({ itemId, qty: "" }))]);
          setPicking(false);
        }}
        onNewItem={() => {
          setPicking(false);
          setNewItem(true);
        }}
        open={picking}
        taken={shownLines.map((line) => line.itemId)}
      />
      <ItemSheet
        existing={home.items.map((item) => item.name)}
        onClose={() => setNewItem(false)}
        onSaved={(id) => {
          setNewItem(false);
          setLines((prev) => [...prev, { itemId: id, qty: "" }]);
          resource.refresh();
        }}
        open={newItem}
      />
    </>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View className="gap-0.5">
      <Text variant="caption">{label}</Text>
      <Text variant="subtitle">{value}</Text>
    </View>
  );
}
