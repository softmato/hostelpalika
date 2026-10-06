import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
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
  isFutureDay,
  parseBsDayInput,
  recentDayChoices,
  toBsDayInput,
} from "@/lib/expenses";
import { formatMoney } from "@/lib/format";
import { invalidateQuery } from "@/lib/query-cache";
import {
  addStockItem,
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
  type StockUnit,
  stockLook,
  stockQuery,
  updateStockItem,
} from "@/lib/stock-api";
import { toastError, toastSuccess } from "@/lib/toast";
import { uploadAsset } from "@/lib/uploads";
import { addBsMonths, bsMonthName, periodParts } from "@hostel/calendar/bs";

/**
 * The pieces every Stock screen is built from (docs/INVENTORY_PLAN.md).
 *
 * The screens follow one shape: a plain header, one job per screen, the items a
 * person actually moved picked from a list rather than a box per item, and one
 * green button at the bottom.
 */

/* ------------------------------------------------------------------ looks */

/** An item's picture: its emoji on a tint of its family colour. */
export function ItemAvatar({ item, size = 40 }: { item: { kind: StockKind; name: string }; size?: number }) {
  const look = stockLook(item);

  return (
    <View
      className="items-center justify-center"
      style={{ backgroundColor: `${look.color}1F`, borderRadius: size * 0.3, height: size, width: size }}
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

/** One figure in the 2×2 on the Overview: a tinted icon, a caption, a value. */
export function StatCard({
  color,
  icon,
  label,
  onPress,
  value,
}: {
  color: string;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress?: () => void;
  value: string;
}) {
  return (
    <Pressable
      accessibilityRole={onPress ? "button" : undefined}
      className="flex-1 flex-row items-center gap-3 rounded-2xl border border-border bg-card p-3.5 active:opacity-80"
      disabled={!onPress}
      onPress={onPress}
    >
      <View
        className="h-10 w-10 items-center justify-center rounded-full"
        style={{ backgroundColor: `${color}1F` }}
      >
        <Ionicons color={color} name={icon} size={20} />
      </View>
      <View className="flex-1">
        <Text numberOfLines={1} variant="caption">
          {label}
        </Text>
        <Text numberOfLines={1} variant="label">
          {value}
        </Text>
      </View>
    </Pressable>
  );
}

/** A Quick Action: a green glyph and a two-word job. */
export function ActionTile({
  caption,
  disabled = false,
  icon,
  label,
  onPress,
}: {
  caption?: string;
  disabled?: boolean;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}) {
  const { colors } = useAppTheme();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      className={`flex-1 flex-row items-center gap-3 rounded-2xl border border-border bg-card p-3.5 active:opacity-80 ${
        disabled ? "opacity-50" : ""
      }`}
      disabled={disabled}
      onPress={onPress}
    >
      <View className="h-10 w-10 items-center justify-center rounded-xl bg-brand-soft">
        <Ionicons color={colors.primary} name={icon} size={20} />
      </View>
      <View className="flex-1">
        <Text numberOfLines={2} variant="label">
          {label}
        </Text>
        {caption ? (
          <Text numberOfLines={1} variant="caption">
            {caption}
          </Text>
        ) : null}
      </View>
    </Pressable>
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
  const view = entryView(entry, mine);
  const short = entry.status === "RECEIVED" && entry.lines.some((line) => (line.receivedQty ?? line.qty) < line.qty);
  const right =
    entry.kind === "BUY" && entry.amount ? formatMoney(entry.amount) : entryQty(entry);

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
            <Pill color="#8E8E93" label="Cancelled" />
          ) : entry.status === "PENDING" ? (
            <Pill color="#007AFF" label="On the way" />
          ) : short ? (
            <Pill color="#FF3B30" label="Short" />
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

/** Paid by, as four pills: Cash first — most hostel spending is cash. */
export function PaidByChips<T extends string>({
  onChange,
  options,
  value,
}: {
  onChange: (value: T) => void;
  options: readonly { label: string; value: T }[];
  value: T;
}) {
  return (
    <View className="flex-row flex-wrap gap-2">
      {options.map((option) => (
        <Chip
          key={option.value}
          label={option.label}
          onPress={() => onChange(option.value)}
          tone={value === option.value ? "brand" : "neutral"}
        />
      ))}
    </View>
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

/** The outlined "+ Add Item" button the forms share. */
export function AddItemButton({ label = "Add Item", onPress }: { label?: string; onPress: () => void }) {
  const { colors } = useAppTheme();

  return (
    <Pressable
      accessibilityRole="button"
      className="min-h-12 flex-row items-center justify-center gap-2 rounded-xl border border-primary bg-card active:bg-brand-soft"
      onPress={onPress}
    >
      <Ionicons color={colors.primary} name="add" size={20} />
      <Text className="font-semibold text-primary" variant="label">
        {label}
      </Text>
    </Pressable>
  );
}

/** A labelled block with an optional action on the right, for forms. */
export function FormSection({ action, children, title }: { action?: ReactNode; children: ReactNode; title: string }) {
  return (
    <View className="gap-3">
      <View className="flex-row items-center justify-between">
        <Text variant="subtitle">{title}</Text>
        {action}
      </View>
      {children}
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

type Draft = { kind: StockKind; lowAt: string; name: string; unit: StockUnit };

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
  const blank: Draft = { kind: defaultKind, lowAt: "", name: "", unit: "KG" };
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

    if (!name) {
      toastError("Name it", "Like Rice or Vegetables.");
      return;
    }

    if (lowAt === false) {
      toastError("Check the low mark", "A number, like 10.");
      return;
    }

    setBusy(true);

    try {
      const saved = await addStockItem({
        kind: draft.kind,
        lowAt: draft.kind === "STORE" ? lowAt : null,
        name,
        unit: draft.unit,
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
                  onPress={() => setDraft({ ...blank, ...starter })}
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

/** Name, kind, unit and low mark — shared by New item and an item's Settings. */
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

      {draft.kind === "STORE" ? (
        <QtyInput
          label="Running low below (optional)"
          onChangeText={(lowAt) => onChange({ lowAt })}
          placeholder="e.g. 10"
          unit={draft.unit}
          value={draft.lowAt}
        />
      ) : null}
    </View>
  );
}

/** An item's Settings tab: the same fields, plus "Still buying it". Owner only. */
export function ItemSettings({ item, onSaved }: { item: StockItem; onSaved: () => void }) {
  const [draft, setDraft] = useState<Draft>({
    kind: item.kind,
    lowAt: item.lowAt === null ? "" : String(item.lowAt),
    name: item.name,
    unit: item.unit,
  });
  const [active, setActive] = useState(item.active);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const lowAt = readQty(draft.lowAt);

    if (!draft.name.trim()) return toastError("Name it", "Like Rice.");
    if (lowAt === false) return toastError("Check the low mark", "A number, like 10.");

    setBusy(true);

    try {
      await updateStockItem(item.id, {
        active,
        kind: draft.kind,
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
          iconBgColor="#34C759"
          right={<Toggle accessibilityLabel="Still buying it" onChange={setActive} value={active} />}
          subtitle="Off hides it from Buy, Send and Count. Its history stays."
          title="Still buying it"
        />
      </Card>
      <Button label="Save item" loading={busy} onPress={() => void save()} />
    </View>
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

export type HistoryFilter = "ALL" | "BOUGHT" | "COUNT" | "GOT_IT" | "SEND";

export const HISTORY_FILTERS: { label: string; value: HistoryFilter }[] = [
  { label: "All", value: "ALL" },
  { label: "Bought", value: "BOUGHT" },
  { label: "Send", value: "SEND" },
  { label: "Got it", value: "GOT_IT" },
  { label: "Count", value: "COUNT" },
];

function matches(filter: HistoryFilter, entry: StockEntry, mine: ReadonlySet<string>) {
  if (filter === "ALL") return true;

  const kind = entryView(entry, mine).kind;

  return filter === "SEND" ? kind === "SEND" || kind === "ON_THE_WAY" : kind === filter;
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
