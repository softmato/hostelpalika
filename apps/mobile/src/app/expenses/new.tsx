import { takeSharedPayment } from "@/lib/shared-payment";
import { api } from "@/lib/api";
import { type ApiEnvelope, unwrap } from "@/lib/api-contract";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";

import { useExpenseAudience } from "@/components/expenses/expense-parts";
import { type ActionTile, ActionTiles } from "@/components/ui/action-grid";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FieldLabel, Input } from "@/components/ui/input";
import { Chip } from "@/components/ui/layout";
import { Screen } from "@/components/ui/screen";
import { Segmented } from "@/components/ui/segmented";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonCard } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { readApiError } from "@/lib/api-contract";
import { prepareEvidenceForUpload } from "@/lib/evidence-image";
import {
  BUILT_IN_CATEGORIES,
  CUSTOM_CATEGORY_ICON,
  EXPENSE_AMOUNT_MAX,
  EXPENSE_PAID_BY,
  EXPENSE_PAID_BY_LABELS,
  EXPENSE_WHAT_MAX,
  type ExpenseCategoryValue,
  type ExpensePaidBy,
  type ExpensePerson,
  bsDayLong,
  groupDigits,
  isFutureDay,
  newClientRequestId,
  parseAmountInput,
  parseBsDayInput,
  recentDayChoices,
  toBsDayInput,
  todayKey,
} from "@/lib/expenses";
import {
  addExpense,
  addExpenseCategory,
  expenseQuery,
  type ExpenseLoad,
  walletQuery,
} from "@/lib/expenses-api";
import { formatMoney } from "@/lib/format";
import { adminQuery } from "@/lib/admin-queries";
import { invalidateQuery } from "@/lib/query-cache";
import { toastError, toastSuccess } from "@/lib/toast";
import { uploadAsset } from "@/lib/uploads";

/**
 * Add expense (docs/EXPENSES_PLAN.md §3.3).
 *
 * One screen, top to bottom, nothing behind a step: **how much → on what →
 * Save.** Everything else already has an answer — today's Nepali date, paid in
 * cash — and is there to change, not to fill in. Built for somebody standing
 * at a shop counter with a bill in one hand, reading A1 English: the category is
 * a tile with a picture, and the words under it are one or two.
 *
 * The amount field opens the number pad on arrival, because the amount is the
 * one thing that cannot have a default.
 */

type Choice =
  | { category: Exclude<ExpenseCategoryValue, "CUSTOM">; customCategoryId?: undefined }
  | { category: "CUSTOM"; customCategoryId: string };

/** "Someone else" in the salary picker — a name typed in, with no account. */
const SOMEONE_ELSE = "__someone_else__";

export default function AddExpenseScreen() {
  const { colors } = useAppTheme();
  const audience = useExpenseAudience();
  const query = expenseQuery(audience, null);
  const resource = useResource<ExpenseLoad>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });
  const home = resource.data?.kind === "ok" ? resource.data.home : null;
  const isOwner = home?.canSeeTotals === true;
  /** "Give cash" on a cash box opens this screen on the tile, with the warden picked. */
  const params = useLocalSearchParams<{ category?: string; to?: string }>();

  const [amountText, setAmountText] = useState("");
  const [choice, setChoice] = useState<Choice | null>(() =>
    params.category === "STAFF_CASH" ? { category: "STAFF_CASH" } : null,
  );
  const [cashTo, setCashTo] = useState<string | null>(params.to ?? null);
  const [what, setWhat] = useState("");
  const [day, setDay] = useState(() => todayKey());
  const [otherDay, setOtherDay] = useState(false);
  const [bsInput, setBsInput] = useState(() => toBsDayInput(todayKey()));
  const [paidBy, setPaidBy] = useState<ExpensePaidBy>("CASH");
  const paidByEdited = useRef(false);
  const [salaryPick, setSalaryPick] = useState<string | null>(null);
  const [salaryName, setSalaryName] = useState("");

  const [photo, setPhoto] = useState<{ assetId: string | null; uri: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const pickTicket = useRef(0);

  const [newCategoryOpen, setNewCategoryOpen] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [savingCategory, setSavingCategory] = useState(false);

  const [saving, setSaving] = useState(false);
  const [tried, setTried] = useState(false);
  /** One id per Save: a retry after a dropped connection returns the same row. */
  const requestId = useRef(newClientRequestId());

  const amount = parseAmountInput(amountText);
  const days = useMemo(() => recentDayChoices(), []);
  const typedDay = otherDay ? parseBsDayInput(bsInput) : day;
  const dayError = otherDay
    ? !typedDay
      ? "Write the Nepali date like 2083-06-15."
      : isFutureDay(typedDay)
        ? "This day has not come yet."
        : null
    : null;

  const people: ExpensePerson[] = useMemo(() => home?.people ?? [], [home?.people]);
  const isSalary = choice?.category === "SALARY";
  const isCash = choice?.category === "STAFF_CASH";
  const needsWhat = choice?.category === "OTHER";
  const cashPeople = useMemo(() => people.filter((person) => person.holdsCash), [people]);
  const proofRequired = home?.proofRequired === true && !isCash;

  const errors = {
    amount:
      amount === null
        ? "Write how much you paid."
        : amount > EXPENSE_AMOUNT_MAX
          ? "That amount is too big. Check it."
          : null,
    category: choice ? null : "Pick what it was for.",
    salary:
      isSalary && salaryPick === SOMEONE_ELSE && salaryName.trim().length < 1
        ? "Write their name."
        : null,
    what: needsWhat && what.trim().length < 1 ? "Write what it was for." : null,
    cashTo: isCash && !cashTo ? "Pick the warden." : null,
    photo: proofRequired && !photo?.assetId ? "Add a photo of the bill or the goods." : null,
  };
  /** Screen order, so the toast names the first thing to fix. */
  const firstError =
    errors.amount ??
    errors.category ??
    errors.cashTo ??
    errors.salary ??
    errors.what ??
    dayError ??
    errors.photo;
  const valid = !firstError && !uploading;

  /* ------------------------------------------------------------- tiles */

  const tiles: ActionTile[] = useMemo(() => {
    // Only the owner hands cash to a warden.
    const builtIn = BUILT_IN_CATEGORIES.filter((category) => isOwner || category.key !== "STAFF_CASH").map((category) => ({
      glyph: colors.primary,
      icon: category.icon,
      key: category.key,
      label: category.label,
      onPress: () => setChoice({ category: category.key }),
      selected: choice?.category === category.key,
      tone: "brand" as const,
    }));

    const custom = (home?.categories ?? [])
      .filter((category) => !category.hidden)
      .map((category) => ({
        glyph: colors.primary,
        icon: CUSTOM_CATEGORY_ICON,
        key: `custom:${category.id}`,
        label: category.name,
        onPress: () => setChoice({ category: "CUSTOM", customCategoryId: category.id }),
        selected: choice?.category === "CUSTOM" && choice.customCategoryId === category.id,
        tone: "brand" as const,
      }));

    const add = isOwner
      ? [
          {
            glyph: colors.mutedForeground,
            icon: "add" as const,
            key: "new-category",
            label: "New",
            onPress: () => setNewCategoryOpen(true),
            tone: "brand" as const,
          },
        ]
      : [];

    return [...builtIn, ...custom, ...add];
  }, [choice, colors.mutedForeground, colors.primary, home?.categories, isOwner]);

  /* ------------------------------------------------------------- photo */

  const pick = useCallback(async (source: "camera" | "library") => {
    const permission =
      source === "camera"
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();

    if (!permission.granted) {
      toastError(
        "Permission needed",
        source === "camera" ? "Allow the camera to take a photo of the bill." : "Allow photos to add the bill.",
      );
      return;
    }

    const result =
      source === "camera"
        ? await ImagePicker.launchCameraAsync({ quality: 0.8 })
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.8 });
    const asset = result.canceled ? null : result.assets[0];

    if (!asset) return;

    pickTicket.current += 1;
    const ticket = pickTicket.current;

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

      if (pickTicket.current === ticket) {
        setPhoto({ assetId, uri: asset.uri });
      }
    } catch (error) {
      if (pickTicket.current === ticket) {
        // No thumbnail after a failed upload: that is how somebody saves
        // believing the bill is attached.
        setPhoto(null);
        toastError("Photo not added", readApiError(error, "Try again, or save without it."));
      }
    } finally {
      if (pickTicket.current === ticket) setUploading(false);
    }
  }, []);

  useEffect(() => {
    if (!home) return;
    void takeSharedPayment().then(async (file) => {
      if (!file) return;
      const ticket = ++pickTicket.current;
      setUploading(true);
      setPhoto({ assetId: null, uri: file.uri });
      try {
        const prepared = await prepareEvidenceForUpload(file);
        const assetId = await uploadAsset(prepared, { kind: "EXPENSE_RECEIPT", label: "Shared receipt" });
        if (pickTicket.current !== ticket) return;
        setPhoto({ assetId, uri: file.uri });
        const result = unwrap(await api.post<ApiEnvelope<{ fields: { amount?: number; method?: string } }>>(
          "/hostel-admin/expenses/receipt/read", { assetId }, { timeout: 45000 }));
        if (pickTicket.current !== ticket) return;
        if (result.fields.amount) setAmountText((value) => value || String(result.fields.amount));
        if (!paidByEdited.current && result.fields.method) {
          const method = result.fields.method;
          setPaidBy(method === "ESEWA" || method === "KHALTI" ? method : "BANK");
        }
        toastSuccess("Receipt added", "Check the amount and payment method before saving.");
      } catch (error) {
        if (pickTicket.current === ticket) {
          setPhoto((current) => current?.assetId ? current : null);
          toastError("Check your receipt", readApiError(error, "Enter the amount yourself, or try adding the receipt again."));
        }
      } finally {
        if (pickTicket.current === ticket) setUploading(false);
      }
    });
  }, [home]);

  const removePhoto = useCallback(() => {
    pickTicket.current += 1;
    setPhoto(null);
    setUploading(false);
  }, []);

  /* -------------------------------------------------------------- save */

  const saveCategory = useCallback(async () => {
    const name = newCategoryName.trim();

    if (name.length < 2) {
      toastError("Name it", "Two letters or more.");
      return;
    }

    setSavingCategory(true);

    try {
      const created = await addExpenseCategory(name);

      setChoice({ category: "CUSTOM", customCategoryId: created.id });
      setNewCategoryOpen(false);
      setNewCategoryName("");
      resource.setData((current) =>
        current?.kind === "ok"
          ? { ...current, home: { ...current.home, categories: [...current.home.categories, created] } }
          : current,
      );
    } catch (error) {
      toastError("Could not add it", readApiError(error));
    } finally {
      setSavingCategory(false);
    }
  }, [newCategoryName, resource]);

  const save = useCallback(async () => {
    setTried(true);

    if (!valid || amount === null || !choice || !typedDay) {
      // The field's own line may be scrolled out of sight; this one is not.
      if (firstError) toastError("Not saved yet", firstError);
      return;
    }

    const person = people.find((entry) => entry.userId === salaryPick);
    const salaryFor = isSalary
      ? person
        ? { name: person.name, userId: person.userId }
        : salaryPick === SOMEONE_ELSE && salaryName.trim()
          ? { name: salaryName.trim() }
          : undefined
      : undefined;

    setSaving(true);

    try {
      const saved = await addExpense(audience, {
        amount,
        category: choice.category,
        clientRequestId: requestId.current,
        customCategoryId: choice.customCategoryId,
        cashTo: isCash && cashTo ? { userId: cashTo } : undefined,
        paidBy,
        photoAssetId: photo?.assetId ?? undefined,
        salaryFor,
        spentOn: typedDay,
        what: what.trim() || undefined,
      });

      toastSuccess(
        saved.cashTo ? "Cash sent" : "Expense added",
        saved.cashTo ? `${formatMoney(saved.amount)} · ${saved.cashTo.name} confirms it` : `${formatMoney(saved.amount)} · ${saved.categoryLabel}`,
      );
      invalidateQuery(expenseQuery(audience, null).key);
      invalidateQuery(walletQuery(isCash && cashTo ? cashTo : null).key);
      // The owner's statement lists expenses as debits.
      invalidateQuery(adminQuery.ledger().key);
      router.back();
    } catch (error) {
      toastError("Not saved", readApiError(error, "Check your internet and tap Save again."));
    } finally {
      setSaving(false);
    }
  }, [
    amount,
    audience,
    cashTo,
    choice,
    firstError,
    isCash,
    isSalary,
    paidBy,
    people,
    photo,
    salaryName,
    salaryPick,
    typedDay,
    valid,
    what,
  ]);

  /* ------------------------------------------------------------ render */

  const header = <AppBar accent centerTitle showBack title="Add expense" />;

  if (resource.loading && !resource.data) {
    return (
      <Screen header={header}>
        <SkeletonCard rows={4} />
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

  if (resource.data?.kind === "denied") {
    return (
      <Screen header={header}>
        <Card className="gap-1">
          <Text variant="label">You cannot add expenses yet</Text>
          <Text variant="muted">Ask the hostel owner to turn on “Add expenses” for you.</Text>
        </Card>
      </Screen>
    );
  }

  return (
    <>
      <Screen
        footer={
          <Button
            disabled={saving || uploading}
            label={uploading ? "Adding photo…" : amount ? `Save ${formatMoney(amount)}` : "Save"}
            loading={saving}
            onPress={() => void save()}
            size="lg"
          />
        }
        header={header}
        scroll
      >
        <View className="gap-6 pb-4 pt-3">
          {/* ------------------------------------------------------ amount */}
          <Card className="items-center gap-1" padding="px-4 py-5">
            <Text variant="caption">{isCash ? "How much did you give?" : "How much did you pay?"}</Text>
            <View className="flex-row items-center justify-center gap-2">
              <Text className="text-muted-foreground" style={{ fontSize: 22, fontWeight: "600" }}>
                Rs
              </Text>
              <TextInput
                accessibilityLabel="Amount in rupees"
                autoFocus
                className="text-foreground"
                inputMode="numeric"
                keyboardType="number-pad"
                maxLength={13}
                onChangeText={(value) => setAmountText(groupDigits(value))}
                placeholder="0"
                placeholderTextColor={colors.mutedForeground}
                style={{ fontSize: 40, fontWeight: "700", minWidth: 80, textAlign: "center" }}
                value={amountText}
              />
              {/* An unseen twin of "Rs": balances the row so the number, not the pair, sits on the centre line. */}
              <Text
                accessibilityElementsHidden
                className="opacity-0"
                importantForAccessibility="no-hide-descendants"
                style={{ fontSize: 22, fontWeight: "600" }}
              >
                Rs
              </Text>
            </View>
            {tried && errors.amount ? (
              <Text className="text-destructive" variant="caption">
                {errors.amount}
              </Text>
            ) : null}
          </Card>

          {/* ---------------------------------------------------- category */}
          <View className="gap-2.5">
            <FieldLabel>Spent on</FieldLabel>
            <ActionTiles tiles={tiles} />
            {tried && errors.category ? (
              <Text className="text-destructive" variant="caption">
                {errors.category}
              </Text>
            ) : null}
          </View>

          {/* -------------------------------------------------- cash to warden */}
          {isCash ? (
            <View className="gap-2.5">
              <FieldLabel>Which warden?</FieldLabel>
              <View className="flex-row flex-wrap gap-2">
                {cashPeople.map((person) => (
                  <Chip
                    key={person.userId}
                    label={person.name}
                    onPress={() => setCashTo(person.userId)}
                    tone={cashTo === person.userId ? "brand" : "neutral"}
                  />
                ))}
              </View>
              {cashPeople.length === 0 ? (
                <Text variant="caption">No warden here has Add expenses on.</Text>
              ) : null}
              {tried && errors.cashTo ? (
                <Text className="text-destructive" variant="caption">
                  {errors.cashTo}
                </Text>
              ) : null}
            </View>
          ) : null}

          {/* ------------------------------------------------------ salary */}
          {isSalary ? (
            <View className="gap-2.5">
              <FieldLabel>Whose salary?</FieldLabel>
              <View className="flex-row flex-wrap gap-2">
                {people.map((person) => (
                  <Chip
                    key={person.userId}
                    label={person.name}
                    onPress={() => setSalaryPick(person.userId)}
                    tone={salaryPick === person.userId ? "brand" : "neutral"}
                  />
                ))}
                <Chip
                  label="Someone else"
                  onPress={() => setSalaryPick(SOMEONE_ELSE)}
                  tone={salaryPick === SOMEONE_ELSE ? "brand" : "neutral"}
                />
              </View>
              {salaryPick === SOMEONE_ELSE ? (
                <Input
                  error={tried ? errors.salary : null}
                  label="Their name"
                  onChangeText={setSalaryName}
                  placeholder="e.g. Sita (cleaner)"
                  value={salaryName}
                />
              ) : null}
            </View>
          ) : null}

          {/* -------------------------------------------------------- what */}
          <Input
            error={tried ? errors.what : null}
            hint={needsWhat ? undefined : "Not needed. Helps you remember."}
            label={needsWhat ? "What was it?" : "What was it? (optional)"}
            maxLength={EXPENSE_WHAT_MAX}
            onChangeText={setWhat}
            placeholder="e.g. Rice 25 kg"
            value={what}
          />

          {/* -------------------------------------------------------- date */}
          <View className="gap-2.5">
            <View className="flex-row items-end justify-between">
              <FieldLabel>Date</FieldLabel>
              <Text className="font-semibold text-foreground" variant="caption">
                {typedDay && !dayError ? bsDayLong(typedDay) : " "}
              </Text>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View className="flex-row gap-2">
                {days.map((choiceDay) => {
                  const on = !otherDay && day === choiceDay.key;

                  return (
                    <Pressable
                      accessibilityRole="radio"
                      accessibilityState={{ checked: on }}
                      className={`items-center rounded-2xl border px-3.5 py-2 active:opacity-70 ${
                        on ? "border-primary bg-primary" : "border-border bg-card"
                      }`}
                      key={choiceDay.key}
                      onPress={() => {
                        setOtherDay(false);
                        setDay(choiceDay.key);
                      }}
                    >
                      <Text
                        className={`text-sm font-semibold ${on ? "text-primary-foreground" : "text-foreground"}`}
                      >
                        {choiceDay.label}
                      </Text>
                      <Text
                        className={on ? "text-primary-foreground" : "text-muted-foreground"}
                        style={{ fontSize: 11 }}
                      >
                        {choiceDay.sub}
                      </Text>
                    </Pressable>
                  );
                })}
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{ checked: otherDay }}
                  className={`items-center justify-center rounded-2xl border px-3.5 py-2 active:opacity-70 ${
                    otherDay ? "border-primary bg-primary" : "border-border bg-card"
                  }`}
                  onPress={() => {
                    setBsInput(toBsDayInput(day));
                    setOtherDay(true);
                  }}
                >
                  <Ionicons
                    color={otherDay ? colors.primaryForeground : colors.foreground}
                    name="calendar-outline"
                    size={18}
                  />
                  <Text
                    className={otherDay ? "text-primary-foreground" : "text-muted-foreground"}
                    style={{ fontSize: 11 }}
                  >
                    Other day
                  </Text>
                </Pressable>
              </View>
            </ScrollView>
            {otherDay ? (
              <Input
                error={dayError}
                hint="Nepali date: year-month-day"
                inputMode="numeric"
                keyboardType="numbers-and-punctuation"
                label="Nepali date"
                onChangeText={setBsInput}
                placeholder="2083-06-15"
                value={bsInput}
              />
            ) : null}
          </View>

          {/* ----------------------------------------------------- paid by */}
          <View className="gap-2.5">
            <FieldLabel>Paid by</FieldLabel>
            <Segmented
              onChange={(value) => { paidByEdited.current = true; setPaidBy(value); }}
              options={EXPENSE_PAID_BY.map((value) => ({ label: EXPENSE_PAID_BY_LABELS[value], value }))}
              value={paidBy}
            />
          </View>

          {/* ------------------------------------------------------- photo */}
          <View className="gap-2.5">
            <FieldLabel>
              {isCash ? "Receipt (optional)" : proofRequired ? "Photo of the bill" : "Photo of the bill (optional)"}
            </FieldLabel>
            {photo ? (
              <View className="flex-row items-center gap-3 rounded-2xl border border-border bg-card p-3">
                <Image
                  contentFit="cover"
                  source={{ uri: photo.uri }}
                  style={{ backgroundColor: colors.muted, borderRadius: 10, height: 64, width: 64 }}
                />
                <Text className="flex-1" variant="label">
                  {uploading ? "Adding photo…" : "Photo added"}
                </Text>
                <Pressable
                  accessibilityLabel="Remove the photo"
                  accessibilityRole="button"
                  className="h-10 w-10 items-center justify-center rounded-full active:opacity-60"
                  hitSlop={6}
                  onPress={removePhoto}
                >
                  <Ionicons color={colors.mutedForeground} name="close-circle" size={22} />
                </Pressable>
              </View>
            ) : (
              <View className="flex-row gap-3">
                <View className="flex-1">
                  <Button label="Take photo" onPress={() => void pick("camera")} variant="outline" />
                </View>
                <View className="flex-1">
                  <Button label="From gallery" onPress={() => void pick("library")} variant="outline" />
                </View>
              </View>
            )}
            {tried && errors.photo ? (
              <Text className="text-destructive" variant="caption">
                {errors.photo}
              </Text>
            ) : null}
          </View>
        </View>
      </Screen>

      <Sheet
        footer={
          <Button label="Add category" loading={savingCategory} onPress={() => void saveCategory()} />
        }
        onClose={() => setNewCategoryOpen(false)}
        open={newCategoryOpen}
        title="New category"
      >
        <View className="gap-3 pb-2">
          <Input
            autoFocus
            hint="It shows as a tile next time, for everyone who adds expenses."
            label="Name"
            maxLength={32}
            onChangeText={setNewCategoryName}
            placeholder="e.g. Printing"
            value={newCategoryName}
          />
        </View>
      </Sheet>
    </>
  );
}
