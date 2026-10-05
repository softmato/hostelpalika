import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";

import { ItemSheet, StockGlyph } from "@/components/stock/stock-parts";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { FieldLabel, Input } from "@/components/ui/input";
import { Chip } from "@/components/ui/layout";
import { RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Segmented } from "@/components/ui/segmented";
import { SkeletonCard } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { adminQuery } from "@/lib/admin-queries";
import { readApiError } from "@/lib/api-contract";
import { prepareEvidenceForUpload } from "@/lib/evidence-image";
import {
  EXPENSE_PAID_BY,
  EXPENSE_PAID_BY_LABELS,
  type ExpensePaidBy,
  groupDigits,
  newClientRequestId,
  parseAmountInput,
  recentDayChoices,
  todayKey,
} from "@/lib/expenses";
import { expenseQuery } from "@/lib/expenses-api";
import { formatMoney } from "@/lib/format";
import { invalidateQuery } from "@/lib/query-cache";
import {
  addStockEntry,
  formatQty,
  parseQtyInput,
  STOCK_UNIT_LABELS,
  type StockHome,
  type StockItem,
  type StockLoad,
  stockQuery,
} from "@/lib/stock-api";
import { toastError, toastSuccess } from "@/lib/toast";
import { uploadAsset } from "@/lib/uploads";

/**
 * Bought · Send · Count — one screen (docs/INVENTORY_PLAN.md).
 *
 * The three are the same act: pick the building, write a number beside each
 * item that moved, Save. So they are one list of items with a box each, and the
 * tabs at the top change only the words and the one or two fields around it —
 * where it goes for a Send, the bill for a Bought. A truck that brings rice,
 * daal and oil on one bill is one Bought with three numbers, not three forms.
 */

type Mode = "buy" | "count" | "send";

const KIND = { buy: "BUY", count: "COUNT", send: "SEND" } as const;
const TITLES: Record<Mode, string> = { buy: "Bought", count: "Count", send: "Send" };

function defaultPlace(home: StockHome, mode: Mode) {
  const mine = home.places.filter((place) => place.mine);
  const main = mine.find((place) => place.isMain);

  return (mode === "buy" && main ? main : mine[0])?.id ?? null;
}

export default function StockEntryScreen() {
  const { colors } = useAppTheme();
  const params = useLocalSearchParams<{ itemId?: string; kind?: string }>();
  const query = stockQuery(null);
  const resource = useResource<StockLoad>(query.load, { cacheKey: query.key, topics: query.topics });
  const home = resource.data?.kind === "ok" ? resource.data.home : null;

  const [mode, setMode] = useState<Mode>(
    params.kind === "send" || params.kind === "count" ? params.kind : "buy",
  );
  const [placePick, setPlace] = useState<string | null>(null);
  const [toPick, setTo] = useState<string | null>(null);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [amountText, setAmountText] = useState("");
  const [paidBy, setPaidBy] = useState<ExpensePaidBy>("CASH");
  const [day, setDay] = useState(() => todayKey());
  const [note, setNote] = useState("");
  const [photo, setPhoto] = useState<{ assetId: string | null; uri: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [itemSheet, setItemSheet] = useState(false);
  const [saving, setSaving] = useState(false);
  const requestId = useRef(newClientRequestId());
  const days = useMemo(() => recentDayChoices(), []);

  const place = placePick ?? (home ? defaultPlace(home, mode) : null);
  const others = home?.places.filter((entry) => entry.id !== place) ?? [];
  const to = toPick && toPick !== place ? toPick : (others[0]?.id ?? null);
  const mine = home?.places.filter((entry) => entry.mine) ?? [];

  const items = useMemo(() => {
    const active = (home?.items ?? []).filter((item) => item.active && (mode !== "count" || item.kind === "STORE"));

    // The item the screen was opened from goes first.
    return [...active].sort((a, b) => Number(b.id === params.itemId) - Number(a.id === params.itemId));
  }, [home, mode, params.itemId]);

  const lines = items
    .map((item) => ({ item, qty: parseQtyInput(qty[item.id] ?? "") }))
    .filter((line) => (qty[line.item.id] ?? "").trim() !== "");
  const badLine = lines.find((line) => line.qty === null || (mode !== "count" && line.qty <= 0));
  const amount = parseAmountInput(amountText);
  const showMoney = mode === "buy" && home?.canSpend === true;
  const photoNeeded = showMoney && amount !== null && home?.proofRequired === true;

  const error =
    lines.length === 0
      ? "Write how much of at least one item."
      : badLine
        ? `Check the number for ${badLine.item.name}.`
        : !place
          ? "Pick the building."
          : mode === "send" && !to
            ? "Pick where it goes."
            : amountText.trim() && amount === null
              ? "Check the bill amount."
              : photoNeeded && !photo?.assetId
                ? "Add a photo of the bill."
                : null;

  /* ------------------------------------------------------------- photo */

  const pickTicket = useRef(0);

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

    const ticket = ++pickTicket.current;

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

      if (pickTicket.current === ticket) setPhoto({ assetId, uri: asset.uri });
    } catch (uploadError) {
      if (pickTicket.current === ticket) {
        setPhoto(null);
        toastError("Photo not added", readApiError(uploadError, "Try again."));
      }
    } finally {
      if (pickTicket.current === ticket) setUploading(false);
    }
  }, []);

  /* -------------------------------------------------------------- save */

  const save = async () => {
    if (error || !place) {
      if (error) toastError("Not saved yet", error);
      return;
    }

    setSaving(true);

    try {
      await addStockEntry({
        amount: showMoney && amount ? amount : undefined,
        clientRequestId: requestId.current,
        hostelId: place,
        kind: KIND[mode],
        lines: lines.map((line) => ({ itemId: line.item.id, qty: line.qty ?? 0 })),
        note: note.trim() || undefined,
        on: day,
        paidBy: showMoney && amount ? paidBy : undefined,
        photoAssetId: showMoney && amount ? (photo?.assetId ?? undefined) : undefined,
        toHostelId: mode === "send" ? (to ?? undefined) : undefined,
      });

      const where = home?.places.find((entry) => entry.id === (mode === "send" ? to : place))?.name ?? "";

      toastSuccess(
        mode === "send" ? `Sent to ${where}` : mode === "count" ? "Count saved" : "Bought saved",
        mode === "send" ? "They tap Got it when it comes." : `${lines.length} item${lines.length === 1 ? "" : "s"}`,
      );
      invalidateQuery(stockQuery(null).key);

      if (showMoney && amount) {
        invalidateQuery(expenseQuery("staff", null).key);
        invalidateQuery(adminQuery.ledger().key);
      }

      router.back();
    } catch (saveError) {
      toastError("Not saved", readApiError(saveError, "Check your internet and tap Save again."));
    } finally {
      setSaving(false);
    }
  };

  /* ------------------------------------------------------------ render */

  const header = <AppBar accent centerTitle showBack title={TITLES[mode]} />;

  if (resource.loading && !resource.data) {
    return (
      <Screen header={header}>
        <SkeletonCard rows={5} />
      </Screen>
    );
  }

  if (resource.error && !resource.data) {
    return (
      <Screen header={header}>
        <ErrorState message={resource.error} onRetry={resource.reload} />
      </Screen>
    );
  }

  if (!home) {
    return (
      <Screen header={header}>
        <Card className="gap-1">
          <Text variant="label">You cannot handle stock yet</Text>
          <Text variant="muted">Ask the hostel owner to turn on “Stock” for you.</Text>
        </Card>
      </Screen>
    );
  }

  const store = items.filter((item) => item.kind === "STORE");
  const daily = items.filter((item) => item.kind === "DAILY");

  const placeChips = (
    value: string | null,
    options: { id: string; name: string }[],
    onPick: (id: string) => void,
  ) => (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View className="flex-row gap-2">
        {options.map((option) => (
          <Chip
            icon="business-outline"
            key={option.id}
            label={option.name}
            onPress={() => onPick(option.id)}
            tone={value === option.id ? "brand" : "neutral"}
          />
        ))}
      </View>
    </ScrollView>
  );

  const itemRows = (list: StockItem[]) => (
    <Card padding="px-4 py-1">
      {list.map((item, index) => {
        const at = item.at.find((row) => row.hostelId === place);
        const hint =
          item.kind === "STORE" && at && mode !== "buy"
            ? `${mode === "count" ? "Book says" : "Left"} ${formatQty(at.left, item.unit)}`
            : item.kind === "DAILY"
              ? "Daily"
              : "Store";

        return (
          <View key={item.id}>
            {index > 0 ? <RowDivider inset /> : null}
            <View className="min-h-14 flex-row items-center gap-3 py-2">
              <StockGlyph item={item} />
              <View className="flex-1">
                <Text numberOfLines={1} variant="label">
                  {item.name}
                </Text>
                <Text numberOfLines={1} variant="caption">
                  {hint}
                </Text>
              </View>
              <View className="flex-row items-center gap-2">
                <TextInput
                  accessibilityLabel={`${item.name} quantity`}
                  className={`w-20 rounded-xl border px-3 py-2 text-right text-base font-semibold text-foreground ${
                    (qty[item.id] ?? "").trim() ? "border-primary bg-brand-soft" : "border-border bg-background"
                  }`}
                  inputMode="decimal"
                  keyboardType="decimal-pad"
                  onChangeText={(value) => setQty((prev) => ({ ...prev, [item.id]: value }))}
                  placeholder="0"
                  placeholderTextColor={colors.mutedForeground}
                  value={qty[item.id] ?? ""}
                />
                <Text className="w-14" numberOfLines={1} variant="caption">
                  {STOCK_UNIT_LABELS[item.unit].many}
                </Text>
              </View>
            </View>
          </View>
        );
      })}
    </Card>
  );

  return (
    <>
      <Screen
        footer={
          <Button
            disabled={saving || uploading}
            label={
              uploading
                ? "Adding photo…"
                : lines.length === 0
                  ? "Save"
                  : `Save · ${lines.length} item${lines.length === 1 ? "" : "s"}${
                      showMoney && amount ? ` · ${formatMoney(amount)}` : ""
                    }`
            }
            loading={saving}
            onPress={() => void save()}
            size="lg"
          />
        }
        header={header}
        scroll
      >
        <View className="gap-6 pb-4 pt-3">
          <Segmented
            onChange={(next) => {
              setMode(next);
              setPlace(null);
            }}
            options={[
              { label: "Bought", value: "buy" as const },
              { label: "Send", value: "send" as const },
              { label: "Count", value: "count" as const },
            ]}
            value={mode}
          />

          <View className="gap-2.5">
            <FieldLabel>
              {mode === "buy" ? "Where did it come?" : mode === "send" ? "From" : "Where are you counting?"}
            </FieldLabel>
            {placeChips(place, mine, setPlace)}
          </View>

          {mode === "send" ? (
            <View className="gap-2.5">
              <FieldLabel>To</FieldLabel>
              {others.length > 0 ? (
                placeChips(to, others, setTo)
              ) : (
                <Text variant="caption">There is no other building to send to yet.</Text>
              )}
            </View>
          ) : null}

          {items.length === 0 ? (
            <EmptyCard
              action={<Button label="Add an item" onPress={() => setItemSheet(true)} size="sm" />}
              description={mode === "count" ? "Only store items are counted." : "Add Rice, Daal, Vegetables…"}
              title="No items yet"
            />
          ) : (
            <>
              {store.length > 0 ? (
                <View>
                  <SectionHeader
                    subtitle={mode === "count" ? "Write what is left now" : undefined}
                    title="Store"
                  />
                  {itemRows(store)}
                </View>
              ) : null}
              {daily.length > 0 ? (
                <View>
                  <SectionHeader title="Daily" />
                  {itemRows(daily)}
                </View>
              ) : null}
            </>
          )}

          <Pressable
            accessibilityRole="button"
            className="flex-row items-center justify-center gap-2 rounded-2xl border border-dashed border-border py-3 active:bg-muted"
            onPress={() => setItemSheet(true)}
          >
            <Ionicons color={colors.primary} name="add-circle-outline" size={20} />
            <Text className="text-primary" variant="label">
              New item
            </Text>
          </Pressable>

          {showMoney ? (
            <Card className="gap-4" padding="px-4 py-4">
              <View className="gap-1">
                <FieldLabel>Bill amount (optional)</FieldLabel>
                <Text variant="caption">Saved in Expenses too, so it is never added twice.</Text>
              </View>
              <View className="flex-row items-center gap-2">
                <Text className="text-muted-foreground" style={{ fontSize: 20, fontWeight: "600" }}>
                  Rs
                </Text>
                <TextInput
                  accessibilityLabel="Bill amount in rupees"
                  className="flex-1 text-foreground"
                  inputMode="numeric"
                  keyboardType="number-pad"
                  maxLength={13}
                  onChangeText={(value) => setAmountText(groupDigits(value))}
                  placeholder="0"
                  placeholderTextColor={colors.mutedForeground}
                  style={{ fontSize: 28, fontWeight: "700" }}
                  value={amountText}
                />
              </View>
              {amount ? (
                <>
                  <Segmented
                    onChange={setPaidBy}
                    options={EXPENSE_PAID_BY.map((value) => ({ label: EXPENSE_PAID_BY_LABELS[value], value }))}
                    value={paidBy}
                  />
                  {photo ? (
                    <View className="flex-row items-center gap-3">
                      <Image
                        contentFit="cover"
                        source={{ uri: photo.uri }}
                        style={{ backgroundColor: colors.muted, borderRadius: 10, height: 56, width: 56 }}
                      />
                      <Text className="flex-1" variant="label">
                        {uploading ? "Adding photo…" : "Bill photo added"}
                      </Text>
                      <Pressable
                        accessibilityLabel="Remove the photo"
                        accessibilityRole="button"
                        hitSlop={6}
                        onPress={() => {
                          pickTicket.current += 1;
                          setPhoto(null);
                          setUploading(false);
                        }}
                      >
                        <Ionicons color={colors.mutedForeground} name="close-circle" size={22} />
                      </Pressable>
                    </View>
                  ) : (
                    <View className="flex-row gap-3">
                      <View className="flex-1">
                        <Button
                          label={photoNeeded ? "Bill photo" : "Photo (optional)"}
                          onPress={() => void pick("camera")}
                          variant="outline"
                        />
                      </View>
                      <View className="flex-1">
                        <Button label="From gallery" onPress={() => void pick("library")} variant="outline" />
                      </View>
                    </View>
                  )}
                </>
              ) : null}
            </Card>
          ) : null}

          <View className="gap-2.5">
            <FieldLabel>Date</FieldLabel>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View className="flex-row gap-2">
                {days.map((choice) => {
                  const on = day === choice.key;

                  return (
                    <Pressable
                      accessibilityRole="radio"
                      accessibilityState={{ checked: on }}
                      className={`items-center rounded-2xl border px-3.5 py-2 active:opacity-70 ${
                        on ? "border-primary bg-primary" : "border-border bg-card"
                      }`}
                      key={choice.key}
                      onPress={() => setDay(choice.key)}
                    >
                      <Text className={`text-sm font-semibold ${on ? "text-primary-foreground" : "text-foreground"}`}>
                        {choice.label}
                      </Text>
                      <Text className={on ? "text-primary-foreground" : "text-muted-foreground"} style={{ fontSize: 11 }}>
                        {choice.sub}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </ScrollView>
          </View>

          <Input
            label="Note (optional)"
            maxLength={200}
            onChangeText={setNote}
            placeholder={mode === "send" ? "e.g. Sent with Ram on the jeep" : "e.g. From Bhatbhateni"}
            value={note}
          />
        </View>
      </Screen>

      <ItemSheet
        existing={home.items.map((item) => item.name)}
        item={null}
        onClose={() => setItemSheet(false)}
        onSaved={() => {
          setItemSheet(false);
          resource.refresh();
        }}
        open={itemSheet}
      />
    </>
  );
}
