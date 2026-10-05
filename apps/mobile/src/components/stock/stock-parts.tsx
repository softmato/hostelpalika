import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { ScrollView, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FieldLabel, Input } from "@/components/ui/input";
import { Chip } from "@/components/ui/layout";
import { ListRow } from "@/components/ui/list-row";
import { Segmented } from "@/components/ui/segmented";
import { Sheet } from "@/components/ui/sheet";
import { Text } from "@/components/ui/text";
import { Toggle } from "@/components/ui/toggle";
import { readApiError } from "@/lib/api-contract";
import {
  addStockItem,
  parseQtyInput,
  STOCK_ITEM_NAME_MAX,
  STOCK_UNIT_LABELS,
  STOCK_UNITS,
  type StockItem,
  type StockKind,
  type StockUnit,
  stockGlyph,
  updateStockItem,
} from "@/lib/stock-api";
import { toastError, toastSuccess } from "@/lib/toast";

/** The tinted square an item reads as — the Finance screen's row icon, at any size. */
export function StockGlyph({ item, size = 32 }: { item: { kind: StockKind; name: string }; size?: number }) {
  const glyph = stockGlyph(item);

  return (
    <View
      className="items-center justify-center shadow-sm"
      style={{ backgroundColor: glyph.color, borderRadius: size * 0.28, height: size, width: size }}
    >
      <Ionicons color="#FFFFFF" name={glyph.icon} size={size * 0.56} />
    </View>
  );
}

/** One tap fills the form — what nearly every hostel buys first. */
const STARTERS: { kind: StockKind; name: string; unit: StockUnit }[] = [
  { kind: "STORE", name: "Rice", unit: "KG" },
  { kind: "STORE", name: "Daal", unit: "KG" },
  { kind: "STORE", name: "Oil", unit: "LITRE" },
  { kind: "STORE", name: "Gas", unit: "CYLINDER" },
  { kind: "STORE", name: "Sugar", unit: "KG" },
  { kind: "DAILY", name: "Vegetables", unit: "KG" },
  { kind: "DAILY", name: "Chicken", unit: "KG" },
  { kind: "DAILY", name: "Milk", unit: "LITRE" },
  { kind: "DAILY", name: "Eggs", unit: "DOZEN" },
];

type Draft = { active: boolean; kind: StockKind; lowAt: string; name: string; unit: StockUnit };

const BLANK: Draft = { active: true, kind: "STORE", lowAt: "", name: "", unit: "KG" };

/**
 * Add or edit an item, in a bottom sheet. `item` set is an edit (owner only on
 * the server); otherwise a new item, with the usual ones one tap away.
 */
export function ItemSheet({
  existing,
  item,
  onClose,
  onSaved,
  open,
}: {
  /** Names already in the list, so a starter that is there is not offered again. */
  existing: readonly string[];
  item: StockItem | null;
  onClose: () => void;
  onSaved: (id: string) => void;
  open: boolean;
}) {
  const [draft, setDraft] = useState<Draft>(BLANK);
  const [busy, setBusy] = useState(false);
  // Fresh form each time the sheet opens, set during render rather than in an effect.
  const openedFor = open ? (item?.id ?? "new") : null;
  const [seen, setSeen] = useState<string | null>(null);

  if (openedFor !== seen) {
    setSeen(openedFor);

    if (openedFor) {
      setDraft(
        item
          ? {
              active: item.active,
              kind: item.kind,
              lowAt: item.lowAt === null ? "" : String(item.lowAt),
              name: item.name,
              unit: item.unit,
            }
          : BLANK,
      );
    }
  }

  const taken = new Set(existing.map((name) => name.toLowerCase()));
  const starters = STARTERS.filter((starter) => !taken.has(starter.name.toLowerCase()));

  const save = async () => {
    const name = draft.name.trim();
    const lowAt = draft.lowAt.trim() ? parseQtyInput(draft.lowAt) : null;

    if (!name) {
      toastError("Name it", "Like Rice or Vegetables.");
      return;
    }

    if (draft.lowAt.trim() && lowAt === null) {
      toastError("Check the low mark", "A number, like 10.");
      return;
    }

    setBusy(true);

    try {
      const input = {
        kind: draft.kind,
        lowAt: draft.kind === "STORE" ? lowAt : null,
        name,
        unit: draft.unit,
      };
      const saved = item
        ? await updateStockItem(item.id, { ...input, active: draft.active })
        : await addStockItem(input);

      toastSuccess(item ? "Item saved" : `${saved.name} added`);
      onSaved(saved.id);
    } catch (error) {
      toastError("Not saved", readApiError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      footer={<Button label={item ? "Save" : "Add item"} loading={busy} onPress={() => void save()} />}
      onClose={onClose}
      open={open}
      title={item ? "Edit item" : "New item"}
    >
      <View className="gap-4 pb-2">
        {!item && starters.length > 0 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View className="flex-row gap-2">
              {starters.map((starter) => (
                <Chip
                  key={starter.name}
                  label={starter.name}
                  onPress={() => setDraft({ ...BLANK, ...starter })}
                  tone={draft.name === starter.name ? "brand" : "neutral"}
                />
              ))}
            </View>
          </ScrollView>
        ) : null}

        <View className="flex-row items-center gap-3">
          <StockGlyph item={{ kind: draft.kind, name: draft.name }} size={48} />
          <View className="flex-1">
            <Input
              label="Item"
              maxLength={STOCK_ITEM_NAME_MAX}
              onChangeText={(name) => setDraft((prev) => ({ ...prev, name }))}
              placeholder="e.g. Rice"
              value={draft.name}
            />
          </View>
        </View>

        <View className="gap-2.5">
          <FieldLabel>Kind</FieldLabel>
          <Segmented
            onChange={(kind) => setDraft((prev) => ({ ...prev, kind }))}
            options={[
              { label: "Store · long use", value: "STORE" as const },
              { label: "Daily · used same day", value: "DAILY" as const },
            ]}
            value={draft.kind}
          />
        </View>

        <View className="gap-2.5">
          <FieldLabel>Counted in</FieldLabel>
          <View className="flex-row flex-wrap gap-2">
            {STOCK_UNITS.map((unit) => (
              <Chip
                key={unit}
                label={STOCK_UNIT_LABELS[unit].many}
                onPress={() => setDraft((prev) => ({ ...prev, unit }))}
                tone={draft.unit === unit ? "brand" : "neutral"}
              />
            ))}
          </View>
        </View>

        {draft.kind === "STORE" ? (
          <Input
            hint="The item turns red when a building has less than this."
            inputMode="decimal"
            keyboardType="decimal-pad"
            label="Running low below (optional)"
            onChangeText={(lowAt) => setDraft((prev) => ({ ...prev, lowAt }))}
            placeholder="e.g. 10"
            trailing={<Text variant="muted">{STOCK_UNIT_LABELS[draft.unit].many}</Text>}
            value={draft.lowAt}
          />
        ) : null}

        {item ? (
          <Card padding="px-4 py-1">
            <ListRow
              icon="eye-outline"
              iconBgColor="#34C759"
              right={
                <Toggle
                  accessibilityLabel="Still buying it"
                  onChange={(active) => setDraft((prev) => ({ ...prev, active }))}
                  value={draft.active}
                />
              }
              subtitle="Off hides it from Bought, Send and Count"
              title="Still buying it"
            />
          </Card>
        ) : null}
      </View>
    </Sheet>
  );
}
