import { router } from "expo-router";
import {
  BedDouble,
  CalendarDays,
  DoorOpen,
  ShieldCheck,
  Users,
} from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";
import { View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Chip } from "@/components/ui/layout";
import { Screen } from "@/components/ui/screen";
import { SkeletonCard } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { createFeeSchedule, type FeeScheduleData } from "@/lib/admin-manage-api";
import { adminQuery } from "@/lib/admin-queries";
import { readApiError } from "@/lib/api-contract";
import { formatMoney } from "@/lib/format";
import { monthStartFromNow, startOfDayIso } from "@/lib/manage-dates";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Set the rates — the form that used to be a bottom sheet on the Finance screen.
 *
 * ## Rates are never edited, and that is why this screen exists
 *
 * There is no PUT. Saving opens a **new** schedule and closes the current one
 * the day before the new rates start, so an invoice issued last March can still
 * be explained rather than merely trusted. The old card stays readable under
 * *Past schedules*.
 *
 * The overview screen used to print that paragraph next to the numbers. It now
 * lives here, next to the date field it actually governs — one sentence under
 * "Effective from" instead of a rule an owner has to read before they can find
 * out what a single bed costs.
 *
 * ## A blank bed type is not free, it is unpriced
 *
 * Leaving a field empty does not charge nothing — it prices nobody, and every
 * resident on that bed type **fails** the next billing run instead of being
 * charged a fallback. That is deliberate (it is the defect this design removed:
 * a misconfigured resident billed a number no human chose), so the hint says so
 * where the fields are rather than after the failure.
 *
 * ## Deleting not-started rates is not here
 *
 * It used to be a ghost button at the foot of this form, so dropping next
 * month's rates meant opening the screen for making new ones. It is now on the
 * not-started card itself in `finance/room-rates`.
 */

/** Matching is case- and punctuation-insensitive, as it is on the server. */
function roomTypeKey(value: string | null | undefined) {
  return (value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export default function ManageRatesScreen() {
  const dates = useDates();
  /*
   * The glyphs below are drawn in `mutedForeground`, not in the brand.
   *
   * A field marker is an aid to scanning a column of near-identical boxes — a
   * rent, a fee, a discount and a deposit all read as "a number in NPR" until
   * something distinguishes them. Painting them green would make four pieces of
   * decoration the loudest thing on the screen and compete with the one control
   * that is actually the accent, which is the footer's Save.
   */
  const { colors } = useAppTheme();
  const [saving, setSaving] = useState(false);
  const [ratesDraft, setRatesDraft] = useState<Record<string, string> | null>(null);
  const [formDraft, setFormDraft] = useState<Record<string, string> | null>(null);

  // The same key `finance/history` reads: one rate card, two views of it.
  const query = adminQuery.feeSchedules();
  const schedules = useResource<FeeScheduleData>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  const open = useMemo(
    () =>
      (schedules.data?.schedules ?? []).find(
        (schedule: { effectiveTo: string | null }) => schedule.effectiveTo === null,
      ) ?? null,
    [schedules.data],
  );

  /*
   * The keys of a rate card: the hostel's own room types.
   *
   * Not `BED_TYPES`. A bed type is a five-value enum derived from free text and
   * it cannot name a room called "Shared", so pricing by bed type left the
   * public listing as a second, separately typed store of the same number — and
   * a hostel ended up advertising 18,000 while its card said 180,000. One box
   * per room the hostel actually rents is what makes one price possible.
   */
  const roomTypes = useMemo(() => schedules.data?.roomTypes ?? [], [schedules.data]);


  /*
   * Seeded from the open card, and the draft wins the moment anything is typed.
   *
   * Not `useState(seed)` plus an effect that re-seeds when the read lands: the
   * silent refocus revalidate in `useResource` would fire that effect again and
   * rewrite a half-typed number under the user's thumb, with the keyboard still
   * up. A null draft simply means "nothing typed yet", so a later response can
   * change what is displayed only while that is still true.
   */
  const seededRates = useMemo(() => {
    const next: Record<string, string> = {};

    for (const option of roomTypes) {
      /*
       * A card saved before rates were keyed by room type carries only a bed
       * type, and an owner opening this screen still has to see the rate they
       * set. The server derives `bedType` from the room type on every write, so
       * an un-migrated rate is the one that has a bed type and no room type.
       */
      const rate =
        open?.rates.find(
          (entry) => roomTypeKey(entry.roomType) === roomTypeKey(option.roomType),
        ) ??
        open?.rates.find(
          (entry) =>
            !entry.roomType &&
            roomTypeKey(entry.bedType) === roomTypeKey(option.roomType),
        );

      next[option.roomType] = rate ? String(rate.monthlyAmount) : "";
    }

    return next;
  }, [open, roomTypes]);

  const seededForm = useMemo(
    () => ({
      admissionFee: open?.admissionFee ? String(open.admissionFee) : "",
      depositAmount: open?.depositAmount ? String(open.depositAmount) : "",
      effectiveFrom: monthStartFromNow(1),
      referralAdmissionDiscount: open?.referralAdmissionDiscount
        ? String(open.referralAdmissionDiscount)
        : "",
    }),
    [open],
  );

  const rates = ratesDraft ?? seededRates;
  const form = formDraft ?? seededForm;

  const editRates = useCallback(
    (patch: Record<string, string>) =>
      setRatesDraft((prev) => ({ ...(prev ?? seededRates), ...patch })),
    [seededRates],
  );

  const editForm = useCallback(
    (patch: Record<string, string>) =>
      setFormDraft((prev) => ({ ...(prev ?? seededForm), ...patch })),
    [seededForm],
  );

  const submit = useCallback(async () => {
    const effectiveFrom = startOfDayIso(form.effectiveFrom ?? "");

    if (!effectiveFrom) {
      toastError("Check the start date", "Write it as YYYY-MM-DD.");
      return;
    }

    const priced = roomTypes.flatMap((option) => {
      const raw = rates[option.roomType]?.trim();

      if (!raw) {
        return [];
      }

      const monthlyAmount = Number(raw);

      return Number.isInteger(monthlyAmount) && monthlyAmount >= 0
        ? [{ monthlyAmount, roomType: option.roomType }]
        : [];
    });

    if (priced.length === 0) {
      toastError("Price at least one room type", "Otherwise nobody can be billed.");
      return;
    }

    setSaving(true);

    try {
      await createFeeSchedule({
        admissionFee: form.admissionFee?.trim() ? Number(form.admissionFee) : undefined,
        depositAmount: form.depositAmount?.trim() ? Number(form.depositAmount) : undefined,
        effectiveFrom,
        rates: priced,
        referralAdmissionDiscount: form.referralAdmissionDiscount?.trim()
          ? Number(form.referralAdmissionDiscount)
          : undefined,
      });
      toastSuccess("Rates saved", "Your public listing now shows these rents.");
      router.back();
    } catch (error) {
      toastError("Could not save", readApiError(error));
    } finally {
      setSaving(false);
    }
  }, [form, rates, roomTypes]);

  if (schedules.loading) {
    return (
      <Screen header={<AppBar accent centerTitle showBack title="Rates" />}>
        <View className="gap-4 pt-1">
          <SkeletonCard rows={3} />
          <SkeletonCard rows={3} />
        </View>
      </Screen>
    );
  }

  if (schedules.error) {
    return (
      <Screen header={<AppBar accent centerTitle showBack title="Rates" />}>
        <ErrorState message={schedules.error} onRetry={schedules.reload} />
      </Screen>
    );
  }

  return (
    <Screen
      footer={
        <Button
          label="Save rates"
          loading={saving}
          onPress={() => void submit()}
        />
      }
      header={
        <AppBar
          accent
          centerTitle
          showBack
          subtitle={
            open ? `Replaces the rates from ${dates.dateBoth(open.effectiveFrom)}` : undefined
          }
          title={open ? "New rates" : "Set the rates"}
        />
      }
      scroll
    >
      <View className="gap-5 pt-1">
        <View>
          <SectionHeader subtitle="Per month, per room type" title="Rent" />
          <Card className="gap-3">
            {roomTypes.length === 0 ? (
              <Text variant="caption">
                Add your room types on the hostel profile first — a rate is set against
                one.
              </Text>
            ) : null}
            {roomTypes.map((option) => (
              <Input
                /*
                 * What the public page says today, under the box. Nothing used to
                 * put these two numbers on one screen, which is how 18,000 on a
                 * listing and 180,000 on a card went unnoticed. After saving they
                 * are the same number by construction.
                 */
                hint={
                  option.monthlyRent > 0
                    ? `Listed at ${formatMoney(option.monthlyRent)}`
                    : "No listed price yet"
                }
                key={option.roomType}
                keyboardType="number-pad"
                label={option.roomType}
                /*
                 * The same glyph for every room type, deliberately. A door for
                 * "Single" and a bunk for "Six Sharing" would be a second,
                 * silent statement about how many people share a room — derived
                 * from free text the hostel typed, wrong the first time a hostel
                 * calls a room "Deluxe", and contradicting the label right
                 * beside it. The mark says "this box is a rent"; the label says
                 * which room.
                 */
                leading={<BedDouble color={colors.mutedForeground} size={18} />}
                onChangeText={(value) => editRates({ [option.roomType]: value })}
                placeholder="NPR"
                value={rates[option.roomType] ?? ""}
              />
            ))}
            <Text variant="caption">
              Leave one blank and it is not priced — those residents are skipped by the
              billing run rather than charged a guess. Saving writes these rents onto
              your public listing, so this is the only place a rent is set.
            </Text>
          </Card>
        </View>

        <View>
          <SectionHeader subtitle="Charged once, on arrival" title="One-off" />
          <Card className="gap-3">
            <Input
              keyboardType="number-pad"
              label="Admission fee"
              leading={<DoorOpen color={colors.mutedForeground} size={18} />}
              onChangeText={(admissionFee) => editForm({ admissionFee })}
              placeholder="NPR"
              value={form.admissionFee ?? ""}
            />
            <Input
              hint="Comes off the admission fee when someone arrives on a resident's referral code. Never off the rent."
              keyboardType="number-pad"
              label="Referral discount"
              leading={<Users color={colors.mutedForeground} size={18} />}
              onChangeText={(referralAdmissionDiscount) => editForm({ referralAdmissionDiscount })}
              placeholder="NPR"
              value={form.referralAdmissionDiscount ?? ""}
            />
            <Input
              keyboardType="number-pad"
              label="Deposit"
              leading={<ShieldCheck color={colors.mutedForeground} size={18} />}
              onChangeText={(depositAmount) => editForm({ depositAmount })}
              placeholder="NPR"
              value={form.depositAmount ?? ""}
            />
          </Card>
        </View>

        <View>
          <SectionHeader title="Effective from" />
          <Card className="gap-3">
            <Input
              /*
               * The box takes a Gregorian date because that is what the API
               * stores, but an owner reading Bikram Sambat cannot tell which
               * Nepali month `2026-10-01` lands in — which is how a card meant
               * for Kartik was set to start in Aswin. The echo below closes that
               * gap without making them convert anything in their head.
               */
              hint={
                startOfDayIso(form.effectiveFrom ?? "")
                  ? dates.dateBoth(startOfDayIso(form.effectiveFrom ?? ""))
                  : undefined
              }
              keyboardType="numbers-and-punctuation"
              leading={<CalendarDays color={colors.mutedForeground} size={18} />}
              onChangeText={(effectiveFrom) => editForm({ effectiveFrom })}
              placeholder="YYYY-MM-DD"
              value={form.effectiveFrom ?? ""}
            />
            <View className="flex-row flex-wrap gap-2">
              {/*
                Months, not day offsets. A "next month" chip that added thirty
                days gave a card starting on the 17th — and rates cannot start
                mid-month, because the billing run gives a whole month to one
                card. Both chips land on a 1st.
              */}
              <Chip
                label="Next month"
                onPress={() => editForm({ effectiveFrom: monthStartFromNow(1) })}
              />
              <Chip
                label="Month after"
                onPress={() => editForm({ effectiveFrom: monthStartFromNow(2) })}
              />
            </View>
            <Text variant="caption">
              New rates always start on the 1st of a month. You cannot change this
              month — those residents are already being billed.
            </Text>
          </Card>
        </View>
      </View>
    </Screen>
  );
}
