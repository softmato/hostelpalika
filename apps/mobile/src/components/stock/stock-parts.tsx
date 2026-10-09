import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Chip } from "@/components/ui/layout";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Segmented } from "@/components/ui/segmented";
import { Sheet, SheetRow } from "@/components/ui/sheet";
import { Text } from "@/components/ui/text";
import { Toggle } from "@/components/ui/toggle";
import { useIsOverall } from "@/components/hostel-switcher";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { readApiError } from "@/lib/api-contract";
import { prepareEvidenceForUpload } from "@/lib/evidence-image";
import {
  bsDayLong,
  bsDayMonth,
  groupDigits,
  isFutureDay,
  parseAmountInput,
  parseBsDayInput,
  recentDayChoices,
  toBsDayInput,
} from "@/lib/expenses";
import { formatMoney } from "@/lib/format";
import { invalidateQuery } from "@/lib/query-cache";
import {
  addStockItem,
  addStockSupplier,
  entryQty,
  entryView,
  parseQtyInput,
  STOCK_ITEM_NAME_MAX,
  STOCK_UNIT_LABELS,
  STOCK_UNITS,
  type StockEntry,
  type StockItem,
  type StockKind,
  type StockLoad,
  type StockSupplier,
  type StockUnit,
  stockLook,
  stockQuery,
  updateStockItem,
} from "@/lib/stock-api";
import { toastError, toastSuccess } from "@/lib/toast";
import { uploadAsset } from "@/lib/uploads";
import { addBsMonths, bsMonthName, periodParts } from "@hostel/calendar/bs";
import { EXPENSE_CATEGORY_LABELS, type ExpenseCategoryKey } from "@hostel/expenses/categories";

/**
 * The pieces every Stock screen is built from (docs/INVENTORY_PLAN.md).
 *
 * The screens follow one shape: a plain header, one job per screen, the items a
 * person actually moved picked from a list rather than a box per item, and one
 * green button at the bottom.
 */

/* ------------------------------------------------------------------ looks */

/**
 * An item's picture: its emoji on the muted ground. The emoji is already the
 * colour; a tint per family put six off-palette hues on one list.
 */
export function ItemAvatar({ item, size = 40 }: { item: { kind: StockKind; name: string }; size?: number }) {
  const look = stockLook(item);

  return (
    <View
      className="items-center justify-center bg-muted"
      style={{ borderRadius: size * 0.3, height: size, width: size }}
    >
      <Text style={{ fontSize: size * 0.52, lineHeight: size * 0.7 }}>{look.emoji}</Text>
    </View>
  );
}

/** `kg`, `L`, `sacks` — the unit as it sits at the end of a field. */
export function unitLabel(unit: StockUnit) {
  return STOCK_UNIT_LABELS[unit]?.many ?? unit.toLowerCase();
}

/** Text tabs with a green underline, as a row under the header. */
export function UnderlineTabs<T extends string>({
  onChange,
  tabs,
  value,
}: {
  onChange: (value: T) => void;
  tabs: readonly { label: string; value: T }[];
  value: T;
}) {
  return (
    <View className="flex-row border-b border-border px-5">
      {tabs.map((tab) => {
        const on = tab.value === value;

        return (
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            className="mr-6 items-center pb-2.5 pt-1 active:opacity-70"
            key={tab.value}
            onPress={() => onChange(tab.value)}
          >
            <Text className={on ? "font-semibold text-primary" : "text-muted-foreground"} variant="label">
              {tab.label}
            </Text>
            <View
              className={on ? "bg-primary" : "bg-transparent"}
              style={{ borderRadius: 2, bottom: -1, height: 3, left: 0, position: "absolute", right: 0 }}
            />
          </Pressable>
        );
      })}
    </View>
  );
}

/** One entry in a list: what happened, from or to where, when — and how much. */
export function EntryRow({
  entry,
  mine,
  onPress,
}: {
  entry: StockEntry;
  mine: ReadonlySet<string>;
  onPress: () => void;
}) {
  const { colors } = useAppTheme();
  const view = entryView(entry, mine);
  const short = entry.status === "RECEIVED" && entry.lines.some((line) => (line.receivedQty ?? line.qty) < line.qty);
  const right =
    entry.kind === "BUY" && entry.bill?.total ? formatMoney(entry.bill.total) : entryQty(entry);
  const billPill =
    entry.status !== "CANCELLED" && entry.bill?.status === "DUE"
      ? "Not paid"
      : entry.status !== "CANCELLED" && entry.bill?.status === "PARTIAL"
        ? "Part paid"
        : null;

  return (
    <Pressable accessibilityRole="button" className="active:opacity-70" onPress={onPress}>
      <View className="min-h-16 flex-row items-center gap-3 py-3">
        <View
          className="h-10 w-10 items-center justify-center rounded-full"
          style={{ backgroundColor: `${view.color}1F` }}
        >
          <Ionicons color={view.color} name={view.icon} size={20} />
        </View>
        <View className="flex-1">
          <Text className={entry.status === "CANCELLED" ? "line-through opacity-60" : ""} variant="label">
            {view.label}
          </Text>
          <Text numberOfLines={1} variant="caption">
            {view.detail}
          </Text>
          <Text numberOfLines={1} variant="caption">
            {bsDayMonth(entry.on)}
          </Text>
        </View>
        <View className="items-end gap-1">
          <Text variant="label">{right}</Text>
          {entry.status === "CANCELLED" ? (
            <Pill color={colors.mutedForeground} label="Cancelled" />
          ) : entry.status === "PENDING" ? (
            <Pill color={colors.warning} label={entry.kind === "COUNT" ? "To approve" : "On the way"} />
          ) : short ? (
            <Pill color={colors.destructive} label="Short" />
          ) : billPill ? (
            <Pill color={colors.warning} label={billPill} />
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

/** A small tinted label: `Low`, `On the way`, `Short`. */
export function Pill({ color, label }: { color: string; label: string }) {
  return (
    <View className="rounded-full px-2.5 py-0.5" style={{ backgroundColor: `${color}1F` }}>
      <Text className="text-xs font-semibold" style={{ color }}>
        {label}
      </Text>
    </View>
  );
}

/* ------------------------------------------------------------------- form */

/** A labelled box with the unit at its end, numeric keypad. */
export function QtyInput({
  error,
  label,
  onChangeText,
  placeholder = "0",
  unit,
  value,
}: {
  error?: string | null;
  label?: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  unit: StockUnit;
  value: string;
}) {
  return (
    <Input
      error={error}
      inputMode="decimal"
      keyboardType="decimal-pad"
      label={label}
      onChangeText={onChangeText}
      placeholder={placeholder}
      selectTextOnFocus
      trailing={<Text variant="muted">{unitLabel(unit)}</Text>}
      value={value}
    />
  );
}

/** `null` when blank, `false` when not a number, else the number. */
export function readQty(text: string | undefined): number | false | null {
  if (!text || !text.trim()) return null;

  const qty = parseQtyInput(text);

  return qty === null ? false : qty;
}

/**
 * The day, shown as a field: `Asoj 15, 2083` with a calendar glyph. Tapping it
 * opens the last week as chips, and a box for an older Nepali date.
 */
export function DateField({
  label = "Date",
  onChange,
  value,
}: {
  label?: string;
  onChange: (day: string) => void;
  value: string;
}) {
  const { colors } = useAppTheme();
  const [open, setOpen] = useState(false);
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState("");
  const days = useMemo(() => recentDayChoices(), []);
  const typedDay = parseBsDayInput(typed);
  const typedError = !typedDay ? "Write it like 2083-06-15." : isFutureDay(typedDay) ? "This day has not come yet." : null;

  return (
    <>
      <View className="gap-1.5">
        <Text variant="caption">{label}</Text>
        <Pressable
          accessibilityLabel={`${label}: ${bsDayLong(value)}. Change`}
          accessibilityRole="button"
          className="min-h-12 flex-row items-center justify-between rounded-xl border border-border bg-card px-3.5 active:opacity-70"
          onPress={() => {
            setTyping(false);
            setTyped(toBsDayInput(value));
            setOpen(true);
          }}
        >
          <Text variant="body">{bsDayLong(value)}</Text>
          <Ionicons color={colors.mutedForeground} name="calendar-outline" size={20} />
        </Pressable>
      </View>

      <Sheet
        footer={
          typing ? (
            <Button
              disabled={Boolean(typedError)}
              label="Use this date"
              onPress={() => {
                if (!typedDay || typedError) return;
                onChange(typedDay);
                setOpen(false);
              }}
            />
          ) : undefined
        }
        onClose={() => setOpen(false)}
        open={open}
        title={label}
      >
        <View className="gap-4 pb-2">
          <View className="flex-row flex-wrap gap-2">
            {days.map((day) => {
              const on = !typing && value === day.key;

              return (
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                  className={`items-center rounded-2xl border px-3.5 py-2 active:opacity-70 ${
                    on ? "border-primary bg-primary" : "border-border bg-card"
                  }`}
                  key={day.key}
                  onPress={() => {
                    onChange(day.key);
                    setOpen(false);
                  }}
                >
                  <Text className={`text-sm font-semibold ${on ? "text-primary-foreground" : "text-foreground"}`}>
                    {day.label}
                  </Text>
                  <Text className={on ? "text-primary-foreground" : "text-muted-foreground"} style={{ fontSize: 11 }}>
                    {day.sub}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {typing ? (
            <Input
              autoFocus
              error={typed.trim() ? typedError : null}
              hint="Nepali date: year-month-day"
              keyboardType="numbers-and-punctuation"
              label="Older day"
              onChangeText={setTyped}
              placeholder="2083-06-15"
              value={typed}
            />
          ) : (
            <Button label="An older day" onPress={() => setTyping(true)} variant="outline" />
          )}
        </View>
      </Sheet>
    </>
  );
}

/**
 * The bill photo: picked, uploaded at once as an expense photo, and held as an
 * asset id. A failed upload leaves no thumbnail — that is how someone saves
 * believing the bill is attached.
 */
export function useBillPhoto() {
  const [photo, setPhoto] = useState<{ assetId: string | null; uri: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const ticket = useRef(0);

  const pick = useCallback(async (source: "camera" | "library") => {
    const permission =
      source === "camera"
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();

    if (!permission.granted) {
      toastError("Permission needed", source === "camera" ? "Allow the camera." : "Allow photos.");
      return;
    }

    const result =
      source === "camera"
        ? await ImagePicker.launchCameraAsync({ quality: 0.8 })
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.8 });
    const asset = result.canceled ? null : result.assets[0];

    if (!asset) return;

    const mineTicket = ++ticket.current;

    setPhoto({ assetId: null, uri: asset.uri });
    setUploading(true);

    try {
      const prepared = await prepareEvidenceForUpload({
        fileName: asset.fileName,
        height: asset.height,
        mimeType: asset.mimeType,
        uri: asset.uri,
        width: asset.width,
      });
      const assetId = await uploadAsset(prepared, { kind: "EXPENSE_RECEIPT", label: "Bill photo" });

      if (ticket.current === mineTicket) setPhoto({ assetId, uri: asset.uri });
    } catch (error) {
      if (ticket.current === mineTicket) {
        setPhoto(null);
        toastError("Photo not added", readApiError(error, "Try again."));
      }
    } finally {
      if (ticket.current === mineTicket) setUploading(false);
    }
  }, []);

  const clear = useCallback(() => {
    ticket.current += 1;
    setPhoto(null);
    setUploading(false);
  }, []);

  return { clear, photo, pick, uploading };
}

/** The dashed box: "Tap to add bill photo", or the photo with a remove cross. */
export function BillPhotoBox({
  bill,
  error,
  required,
}: {
  bill: ReturnType<typeof useBillPhoto>;
  error?: string | null;
  required: boolean;
}) {
  const { colors } = useAppTheme();
  const [choosing, setChoosing] = useState(false);

  return (
    <View className="gap-1.5">
      <Text variant="caption">{required ? "Bill photo (required)" : "Bill photo (optional)"}</Text>
      {bill.photo ? (
        <View className="flex-row items-center gap-3 rounded-2xl border border-border bg-card p-3">
          <Image
            contentFit="cover"
            source={{ uri: bill.photo.uri }}
            style={{ backgroundColor: colors.muted, borderRadius: 10, height: 64, width: 64 }}
          />
          <Text className="flex-1" variant="label">
            {bill.uploading ? "Adding photo…" : "Bill photo added"}
          </Text>
          <Pressable accessibilityLabel="Remove the photo" accessibilityRole="button" hitSlop={8} onPress={bill.clear}>
            <Ionicons color={colors.mutedForeground} name="close-circle" size={24} />
          </Pressable>
        </View>
      ) : (
        <Pressable
          accessibilityRole="button"
          className={`h-32 items-center justify-center gap-2 rounded-2xl border border-dashed bg-card active:bg-muted ${
            error ? "border-destructive" : "border-border"
          }`}
          onPress={() => setChoosing(true)}
        >
          <Ionicons color={colors.primary} name="camera-outline" size={28} />
          <Text variant="muted">Tap to add bill photo</Text>
        </Pressable>
      )}
      {error ? (
        <Text className="text-destructive" variant="caption">
          {error}
        </Text>
      ) : null}

      <Sheet onClose={() => setChoosing(false)} open={choosing} title="Bill photo">
        <View className="gap-1 pb-2">
          <SheetRow
            label="Take photo"
            onPress={() => {
              setChoosing(false);
              void bill.pick("camera");
            }}
          />
          <SheetRow
            label="From gallery"
            onPress={() => {
              setChoosing(false);
              void bill.pick("library");
            }}
          />
        </View>
      </Sheet>
    </View>
  );
}

/* ----------------------------------------------------------------- picker */

/**
 * "Add Item": a searchable list of the hostel's items, tick as many as moved,
 * Done. Items already on the form are shown ticked and cannot be added twice.
 * The bottom row adds a new item without leaving the form.
 */
export function ItemPicker({
  items,
  onClose,
  onDone,
  onNewItem,
  open,
  taken,
}: {
  items: readonly StockItem[];
  onClose: () => void;
  onDone: (ids: string[]) => void;
  onNewItem: () => void;
  open: boolean;
  taken: readonly string[];
}) {
  const { colors } = useAppTheme();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [seen, setSeen] = useState(open);

  // Fresh each time it opens, set during render rather than in an effect.
  if (open !== seen) {
    setSeen(open);
    if (open) {
      setQuery("");
      setPicked([]);
    }
  }

  const shown = items.filter((item) => item.name.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <Sheet
      footer={
        <Button
          disabled={picked.length === 0}
          label={picked.length > 0 ? `Add ${picked.length} item${picked.length === 1 ? "" : "s"}` : "Pick items"}
          onPress={() => onDone(picked)}
        />
      }
      onClose={onClose}
      open={open}
      tall
      title="Add Item"
    >
      <View className="gap-3 pb-2">
        <Input
          leading={<Ionicons color={colors.mutedForeground} name="search" size={18} />}
          onChangeText={setQuery}
          placeholder="Search items…"
          value={query}
        />
        <Card padding="px-4 py-1">
          {shown.map((item, index) => {
            const already = taken.includes(item.id);
            const on = already || picked.includes(item.id);

            return (
              <View key={item.id}>
                {index > 0 ? <RowDivider inset /> : null}
                <Pressable
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on, disabled: already }}
                  className="min-h-14 flex-row items-center gap-3 py-2 active:opacity-70"
                  disabled={already}
                  onPress={() =>
                    setPicked((prev) => (prev.includes(item.id) ? prev.filter((id) => id !== item.id) : [...prev, item.id]))
                  }
                >
                  <ItemAvatar item={item} size={36} />
                  <View className="flex-1">
                    <Text variant="label">{item.name}</Text>
                    <Text variant="caption">
                      {already ? "Already added" : `${item.kind === "DAILY" ? "Daily" : "Store"} · ${unitLabel(item.unit)}`}
                    </Text>
                  </View>
                  <Ionicons
                    color={on ? colors.primary : colors.border}
                    name={on ? "checkmark-circle" : "ellipse-outline"}
                    size={24}
                  />
                </Pressable>
              </View>
            );
          })}
          {shown.length > 0 ? <RowDivider inset /> : null}
          <ListRow icon="add" iconBgColor={colors.primary} onPress={onNewItem} title="New item" />
        </Card>
      </View>
    </Sheet>
  );
}

/* ------------------------------------------------------------- new item */

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

type Draft = {
  category: string;
  kind: StockKind;
  location: string;
  lowAt: string;
  name: string;
  packSize: string;
  packUnit: StockUnit | null;
  unit: StockUnit;
};

/** What an item's purchase is filed under in Money Out — the kitchen and store ones only. */
export const STOCK_CATEGORIES = ["GROCERIES", "VEGETABLES_MEAT", "GAS", "WATER", "CLEANING", "OTHER"] as const;

export function categoryLabel(category: string) {
  return EXPENSE_CATEGORY_LABELS[category as ExpenseCategoryKey] ?? "Other";
}

/** The units an item can be bought in by the pack. */
const PACK_UNITS: StockUnit[] = ["SACK", "PACKET", "DOZEN", "BOTTLE", "TIN", "PIECE"];

/** Add a new item, in a bottom sheet, with the usual ones one tap away. */
export function ItemSheet({
  defaultKind = "STORE",
  existing,
  onClose,
  onSaved,
  open,
}: {
  defaultKind?: StockKind;
  /** Names already in the list, so a starter that is there is not offered again. */
  existing: readonly string[];
  onClose: () => void;
  onSaved: (id: string) => void;
  open: boolean;
}) {
  const blank: Draft = {
    category: defaultKind === "DAILY" ? "VEGETABLES_MEAT" : "GROCERIES",
    kind: defaultKind,
    location: "",
    lowAt: "",
    name: "",
    packSize: "",
    packUnit: null,
    unit: "KG",
  };
  const [draft, setDraft] = useState<Draft>(blank);
  const [busy, setBusy] = useState(false);
  const [seen, setSeen] = useState(open);

  if (open !== seen) {
    setSeen(open);
    if (open) setDraft(blank);
  }

  const taken = new Set(existing.map((name) => name.toLowerCase()));
  const starters = STARTERS.filter((starter) => !taken.has(starter.name.toLowerCase()));

  const save = async () => {
    const name = draft.name.trim();
    const lowAt = readQty(draft.lowAt);
    const pack = readPack(draft);

    if (!name) {
      toastError("Name it", "Like Rice or Vegetables.");
      return;
    }

    if (lowAt === false) {
      toastError("Check the low mark", "A number, like 10.");
      return;
    }

    if (pack === false) {
      toastError("Check the pack size", "How many in one pack, like 25.");
      return;
    }

    setBusy(true);

    try {
      const saved = await addStockItem({
        category: draft.category,
        kind: draft.kind,
        location: draft.location.trim() || undefined,
        lowAt: draft.kind === "STORE" ? lowAt : null,
        name,
        unit: draft.unit,
        ...pack,
      });

      toastSuccess(`${saved.name} added`);
      onSaved(saved.id);
    } catch (error) {
      toastError("Not saved", readApiError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      footer={<Button label="Add item" loading={busy} onPress={() => void save()} />}
      onClose={onClose}
      open={open}
      title="New item"
    >
      <View className="gap-4 pb-2">
        {starters.length > 0 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View className="flex-row gap-2">
              {starters.map((starter) => (
                <Chip
                  key={starter.name}
                  label={starter.name}
                  onPress={() =>
                    setDraft({
                      ...blank,
                      ...starter,
                      category: starter.kind === "DAILY" ? "VEGETABLES_MEAT" : starter.unit === "CYLINDER" ? "GAS" : "GROCERIES",
                    })
                  }
                  tone={draft.name === starter.name ? "brand" : "neutral"}
                />
              ))}
            </View>
          </ScrollView>
        ) : null}
        <ItemFields draft={draft} onChange={(change) => setDraft((prev) => ({ ...prev, ...change }))} />
      </View>
    </Sheet>
  );
}

/** `{ packUnit, packSize }` from the draft, `false` when the size is not a number. */
function readPack(draft: Draft): { packSize: number | null; packUnit: StockUnit | null } | false {
  if (!draft.packUnit) return { packSize: null, packUnit: null };

  const size = readQty(draft.packSize);

  if (size === false || size === null || size <= 0) return false;

  return { packSize: size, packUnit: draft.packUnit };
}

/** Name, kind, unit, pack, low mark, category and place — shared by New item and an item's Settings. */
export function ItemFields({
  draft,
  onChange,
  unitLocked = false,
}: {
  draft: Draft;
  onChange: (change: Partial<Draft>) => void;
  unitLocked?: boolean;
}) {
  return (
    <View className="gap-4">
      <View className="flex-row items-end gap-3">
        <ItemAvatar item={{ kind: draft.kind, name: draft.name }} size={48} />
        <View className="flex-1">
          <Input
            label="Item name"
            maxLength={STOCK_ITEM_NAME_MAX}
            onChangeText={(name) => onChange({ name })}
            placeholder="e.g. Rice (Chamal)"
            value={draft.name}
          />
        </View>
      </View>

      <View className="gap-1.5">
        <Text variant="caption">Kind</Text>
        <Segmented
          onChange={(kind) => onChange({ kind })}
          options={[
            { label: "Store · long use", value: "STORE" as const },
            { label: "Daily · used same day", value: "DAILY" as const },
          ]}
          value={draft.kind}
        />
      </View>

      <View className="gap-1.5">
        <Text variant="caption">{unitLocked ? "Unit (fixed once stock was entered)" : "Unit"}</Text>
        <View className="flex-row flex-wrap gap-2">
          {STOCK_UNITS.map((unit) => (
            <Chip
              key={unit}
              label={unitLabel(unit)}
              onPress={unitLocked ? undefined : () => onChange({ unit })}
              tone={draft.unit === unit ? "brand" : "neutral"}
            />
          ))}
        </View>
      </View>

      <View className="gap-1.5">
        <Text variant="caption">Bought in packs? (optional)</Text>
        <View className="flex-row flex-wrap gap-2">
          <Chip label="No" onPress={() => onChange({ packUnit: null })} tone={draft.packUnit ? "neutral" : "brand"} />
          {PACK_UNITS.filter((unit) => unit !== draft.unit).map((unit) => (
            <Chip
              key={unit}
              label={STOCK_UNIT_LABELS[unit].one}
              onPress={() => onChange({ packUnit: unit })}
              tone={draft.packUnit === unit ? "brand" : "neutral"}
            />
          ))}
        </View>
        {draft.packUnit ? (
          <QtyInput
            label={`1 ${STOCK_UNIT_LABELS[draft.packUnit].one} has`}
            onChangeText={(packSize) => onChange({ packSize })}
            placeholder="e.g. 25"
            unit={draft.unit}
            value={draft.packSize}
          />
        ) : null}
      </View>

      {draft.kind === "STORE" ? (
        <QtyInput
          label="Running low below (optional)"
          onChangeText={(lowAt) => onChange({ lowAt })}
          placeholder="e.g. 10"
          unit={draft.unit}
          value={draft.lowAt}
        />
      ) : null}

      <View className="gap-1.5">
        <Text variant="caption">Money Out group</Text>
        <View className="flex-row flex-wrap gap-2">
          {STOCK_CATEGORIES.map((category) => (
            <Chip
              key={category}
              label={categoryLabel(category)}
              onPress={() => onChange({ category })}
              tone={draft.category === category ? "brand" : "neutral"}
            />
          ))}
        </View>
      </View>

      <Input
        label="Kept in (optional)"
        maxLength={40}
        onChangeText={(location) => onChange({ location })}
        placeholder="e.g. Store room"
        value={draft.location}
      />
    </View>
  );
}

/** An item's Settings tab: the same fields, plus "Still buying it". Owner only. */
export function ItemSettings({ item, onSaved }: { item: StockItem; onSaved: () => void }) {
  const { colors } = useAppTheme();
  const [draft, setDraft] = useState<Draft>({
    category: item.category,
    kind: item.kind,
    location: item.location,
    lowAt: item.lowAt === null ? "" : String(item.lowAt),
    name: item.name,
    packSize: item.packSize === null ? "" : String(item.packSize),
    packUnit: item.packUnit,
    unit: item.unit,
  });
  const [active, setActive] = useState(item.active);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const lowAt = readQty(draft.lowAt);
    const pack = readPack(draft);

    if (!draft.name.trim()) return toastError("Name it", "Like Rice.");
    if (lowAt === false) return toastError("Check the low mark", "A number, like 10.");
    if (pack === false) return toastError("Check the pack size", "How many in one pack, like 25.");

    setBusy(true);

    try {
      await updateStockItem(item.id, {
        active,
        category: draft.category,
        kind: draft.kind,
        location: draft.location.trim(),
        ...pack,
        lowAt: draft.kind === "STORE" ? lowAt : null,
        name: draft.name.trim(),
        ...(draft.unit !== item.unit ? { unit: draft.unit } : {}),
      });
      toastSuccess("Item saved");
      onSaved();
    } catch (error) {
      toastError("Not saved", readApiError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View className="gap-5">
      <ItemFields draft={draft} onChange={(change) => setDraft((prev) => ({ ...prev, ...change }))} />
      <Card padding="px-4 py-1">
        <ListRow
          icon="eye-outline"
          iconBgColor={colors.primary}
          right={<Toggle accessibilityLabel="Still buying it" onChange={setActive} value={active} />}
          subtitle="Off hides it from Buy, Use, Send and Count. Its history stays."
          title="Still buying it"
        />
      </Card>
      <Button label="Save item" loading={busy} onPress={() => void save()} />
    </View>
  );
}

/* -------------------------------------------------------------- amounts */

/** A rupee box: `Rs` in front, digits grouped as typed, number pad. */
export function MoneyInput({
  error,
  hint,
  label,
  onChangeText,
  value,
}: {
  error?: string | null;
  hint?: string;
  label?: string;
  onChangeText: (value: string) => void;
  value: string;
}) {
  return (
    <Input
      error={error}
      hint={hint}
      inputMode="numeric"
      keyboardType="number-pad"
      label={label}
      leading={<Text variant="muted">Rs</Text>}
      onChangeText={(next) => onChangeText(groupDigits(next))}
      placeholder="0"
      selectTextOnFocus
      value={value}
    />
  );
}

/** `null` blank, `false` not whole rupees, else the number. */
export function readRupees(text: string): number | false | null {
  if (!text.trim()) return null;

  const value = parseAmountInput(text);

  return value === null ? false : value;
}

/**
 * Tap-to-add amounts under a quantity box: `+1`, `+5`, `+10`, and `+1 sack`
 * when the item comes in packs. The thumb does the typing.
 */
export function QuickQty({
  item,
  onAdd,
}: {
  item: Pick<StockItem, "packSize" | "packUnit" | "unit">;
  onAdd: (qty: number) => void;
}) {
  const steps = item.unit === "KG" || item.unit === "LITRE" ? [0.5, 1, 2, 5] : [1, 2, 5, 10];

  return (
    <View className="flex-row flex-wrap gap-2">
      {steps.map((step) => (
        <Pressable
          accessibilityLabel={`Add ${step} ${unitLabel(item.unit)}`}
          accessibilityRole="button"
          className="min-h-10 min-w-14 items-center justify-center rounded-xl bg-muted px-3 active:opacity-70"
          key={step}
          onPress={() => onAdd(step)}
        >
          <Text className="text-sm font-semibold">+{step}</Text>
        </Pressable>
      ))}
      {item.packUnit && item.packSize ? (
        <Pressable
          accessibilityRole="button"
          className="min-h-10 items-center justify-center rounded-xl bg-brand-soft px-3 active:opacity-70"
          onPress={() => onAdd(item.packSize!)}
        >
          <Text className="text-sm font-semibold text-primary">+1 {STOCK_UNIT_LABELS[item.packUnit].one}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** `2.5` — a quantity as it goes back into a box. */
export function qtyText(qty: number) {
  return String(Math.round(qty * 100) / 100);
}

/* ------------------------------------------------------------- suppliers */

/**
 * The supplier on a bill, as a field. Tapping it opens the list — searchable,
 * with what is owed beside each name for someone who sees money — and a
 * "New supplier" row that adds one without leaving the bill.
 */
export function SupplierField({
  error,
  money,
  onChange,
  onCreated,
  suppliers,
  value,
}: {
  error?: string | null;
  money: boolean;
  onChange: (id: string | null) => void;
  onCreated: () => void;
  suppliers: readonly StockSupplier[];
  value: string | null;
}) {
  const { colors } = useAppTheme();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const picked = suppliers.find((supplier) => supplier.id === value) ?? null;
  const shown = suppliers.filter(
    (supplier) => supplier.active && supplier.name.toLowerCase().includes(query.trim().toLowerCase()),
  );

  const create = async () => {
    if (!name.trim()) return toastError("Name the shop", "Like Ram Kirana Pasal.");

    setBusy(true);

    try {
      const saved = await addStockSupplier({ name: name.trim(), phone: phone.trim() || undefined });

      toastSuccess(`${saved.name} added`);
      onChange(saved.id);
      onCreated();
      setAdding(false);
      setOpen(false);
    } catch (error) {
      toastError("Not saved", readApiError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <View className="gap-1.5">
        <Text variant="caption">Supplier</Text>
        <Pressable
          accessibilityLabel={`Supplier: ${picked?.name ?? "none"}. Change`}
          accessibilityRole="button"
          className={`min-h-12 flex-row items-center gap-3 rounded-xl border bg-card px-3.5 active:opacity-70 ${
            error ? "border-destructive" : "border-border"
          }`}
          onPress={() => {
            setQuery("");
            setAdding(suppliers.length === 0);
            setName("");
            setPhone("");
            setOpen(true);
          }}
        >
          <Ionicons color={colors.primary} name="storefront-outline" size={20} />
          <Text className={`flex-1 ${picked ? "" : "text-muted-foreground"}`} numberOfLines={1} variant="body">
            {picked?.name ?? "Pick the shop (optional when paid)"}
          </Text>
          <Ionicons color={colors.mutedForeground} name="chevron-down" size={18} />
        </Pressable>
        {error ? (
          <Text className="text-destructive" variant="caption">
            {error}
          </Text>
        ) : null}
      </View>

      <Sheet
        footer={adding ? <Button label="Add supplier" loading={busy} onPress={() => void create()} /> : undefined}
        onClose={() => setOpen(false)}
        open={open}
        tall={!adding}
        title={adding ? "New supplier" : "Supplier"}
      >
        {adding ? (
          <View className="gap-4 pb-2">
            <Input autoFocus label="Shop or person" maxLength={60} onChangeText={setName} placeholder="e.g. Ram Kirana Pasal" value={name} />
            <Input keyboardType="phone-pad" label="Phone (optional)" maxLength={20} onChangeText={setPhone} placeholder="98XXXXXXXX" value={phone} />
          </View>
        ) : (
          <View className="gap-3 pb-2">
            {suppliers.length > 6 ? (
              <Input
                leading={<Ionicons color={colors.mutedForeground} name="search" size={18} />}
                onChangeText={setQuery}
                placeholder="Search suppliers"
                value={query}
              />
            ) : null}
            <Card padding="px-4 py-1">
              {value ? (
                <>
                  <ListRow icon="close" iconBgColor={colors.mutedForeground} onPress={() => { onChange(null); setOpen(false); }} title="No supplier" />
                  <RowDivider inset />
                </>
              ) : null}
              {shown.map((supplier) => (
                <View key={supplier.id}>
                  <SheetRow
                    label={supplier.name}
                    onPress={() => {
                      onChange(supplier.id);
                      setOpen(false);
                    }}
                    selected={supplier.id === value}
                    subtitle={
                      money && supplier.due
                        ? supplier.due > 0
                          ? `${formatMoney(supplier.due)} due`
                          : `${formatMoney(-supplier.due)} paid ahead`
                        : supplier.phone || undefined
                    }
                  />
                </View>
              ))}
              {shown.length > 0 ? <RowDivider inset /> : null}
              <ListRow icon="add" iconBgColor={colors.primary} onPress={() => setAdding(true)} title="New supplier" />
            </Card>
          </View>
        )}
      </Sheet>
    </>
  );
}

/* -------------------------------------------------------------- denied */

export function NoStockAccess() {
  return (
    <Card className="gap-1">
      <Text variant="label">You cannot handle stock yet</Text>
      <Text variant="muted">Ask the hostel owner to turn on “Stock” for you.</Text>
    </Card>
  );
}

/* ------------------------------------------------------------------- data */

/**
 * The month's stock, as every Stock screen reads it. `null` period is this
 * month — the one cache entry the forms, Got it and the home all share, so a
 * Save invalidates exactly what they all paint from.
 */
export function useStock(period: string | null = null) {
  const overall = useIsOverall();
  const query = stockQuery(period);
  const resource = useResource<StockLoad>(query.load, { cacheKey: query.key, topics: query.topics });
  const home = resource.data?.kind === "ok" ? resource.data.home : null;
  const mine = useMemo(() => new Set((home?.places ?? []).filter((place) => place.mine).map((place) => place.id)), [home]);
  /** The building being worked in. `null` in Overall, which works in none. */
  const here = overall ? null : (home?.places.find((place) => place.mine) ?? null);

  return {
    denied: resource.data?.kind === "denied",
    here,
    home,
    mine,
    overall,
    resource,
  };
}

/** After any Save: the forms, the home and Got it all read this month's entry. */
export function stockChanged() {
  invalidateQuery(stockQuery(null).key);
}

/* ---------------------------------------------------------------- history */

export type HistoryFilter = "ALL" | "BOUGHT" | "COUNT" | "GOT_IT" | "SEND" | "USED" | "WASTED";

export const HISTORY_FILTERS: { label: string; value: HistoryFilter }[] = [
  { label: "All", value: "ALL" },
  { label: "Bought", value: "BOUGHT" },
  { label: "Used", value: "USED" },
  { label: "Wasted", value: "WASTED" },
  { label: "Send", value: "SEND" },
  { label: "Got it", value: "GOT_IT" },
  { label: "Count", value: "COUNT" },
];

function matches(filter: HistoryFilter, entry: StockEntry, mine: ReadonlySet<string>) {
  if (filter === "ALL") return true;

  const kind = entryView(entry, mine).kind;

  if (filter === "SEND") return kind === "SEND" || kind === "ON_THE_WAY";
  if (filter === "BOUGHT") return kind === "BOUGHT" || kind === "OPENING";

  return kind === filter;
}

/** `Asoj 2083` from `2083-06`. */
export function monthLabel(period: string) {
  const parts = periodParts(period);

  return parts ? `${bsMonthName(parts.month)} ${parts.year}` : period;
}

/**
 * Entries month by month, newest first, the month's name above its card. Starts
 * with this month; "Show Bhadra 2083" reaches back one month at a time, each
 * month its own read so going back costs nothing until asked for.
 */
export function HistoryMonths({ filter, itemId }: { filter: HistoryFilter; itemId?: string }) {
  const { home } = useStock();
  const [extra, setExtra] = useState(0);

  if (!home) return null;

  const periods = [home.currentPeriod, ...Array.from({ length: extra }, (_, index) => addBsMonths(home.currentPeriod, -(index + 1)))];
  const next = addBsMonths(home.currentPeriod, -(extra + 1));

  return (
    <View className="gap-5">
      {periods.map((period, index) => (
        <MonthSection filter={filter} itemId={itemId} key={period} period={index === 0 ? null : period} />
      ))}
      {extra < 24 ? (
        <Button label={`Show ${monthLabel(next)}`} onPress={() => setExtra((count) => count + 1)} variant="outline" />
      ) : null}
    </View>
  );
}

function MonthSection({ filter, itemId, period }: { filter: HistoryFilter; itemId?: string; period: string | null }) {
  const { home, mine, resource } = useStock(period);

  if (!home) {
    return resource.error ? <Text variant="muted">{resource.error}</Text> : <Text variant="muted">Loading…</Text>;
  }

  const rows = home.entries.filter(
    (entry) => matches(filter, entry, mine) && (!itemId || entry.lines.some((line) => line.itemId === itemId)),
  );

  return (
    <View className="gap-2">
      <Text className="font-semibold uppercase tracking-wider text-muted-foreground" style={{ fontSize: 11 }}>
        {monthLabel(home.period)}
      </Text>
      {rows.length === 0 ? (
        <Text variant="muted">Nothing this month.</Text>
      ) : (
        <Card padding="px-4 py-0">
          {rows.map((entry, index) => (
            <View key={entry.id}>
              {index > 0 ? <RowDivider inset /> : null}
              <EntryRow
                entry={entry}
                mine={mine}
                onPress={() =>
                  router.push({
                    params: period ? { id: entry.id, period } : { id: entry.id },
                    pathname: "/stock/entry/[id]",
                  })
                }
              />
            </View>
          ))}
        </Card>
      )}
    </View>
  );
}
