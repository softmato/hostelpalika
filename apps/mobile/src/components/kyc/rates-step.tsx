import { useManagedHostel } from "@/components/kyc/use-managed-hostel";
import { bedsForRoomType, ROOM_TYPE_OPTIONS, roomTypeLabel } from "@hostel/constants/room-types";
import { useCallback, useState } from "react";
import { Pressable, View } from "react-native";
import { useKycDraft } from "@/components/manage/kyc-draft";
import { Glyph, type GlyphName } from "@/components/ui/glyph";
import { Sheet } from "@/components/ui/sheet";
import { PHOTO_LIMITS, PhotoStrip, targetKey, useHostelPhotoActions } from "@/components/manage/hostel-photos";
import { StepSection } from "@/components/step-flow";
import { Badge } from "@/components/ui/badge";
import { IconButton } from "@/components/ui/icon-button";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SkeletonCard } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { openConfirm } from "@/lib/confirm";
import { type FeeScheduleData, type ManagedHostel, saveKycRates, updateManagedHostel } from "@/lib/admin-manage-api";
import { adminQuery } from "@/lib/admin-queries";
import { readApiError } from "@/lib/api-contract";
import { toastError, toastSuccess } from "@/lib/toast";

/** The joining fees — one figure each for the whole hostel. */
const FEE_FIELDS = [
  { field: "admissionFee", icon: "pricetag", label: "Admission" },
  { field: "formFee", icon: "document-text", label: "Form fee" },
  { field: "depositAmount", icon: "wallet", label: "Deposit" },
] as const satisfies readonly { field: string; icon: GlyphName; label: string }[];
type FeeField = (typeof FEE_FIELDS)[number]["field"];

/**
 * Room type setup: pick the types, then each one's rent and photos, and the
 * joining fees once for the hostel. Beds come from the type's name and are never asked; how many
 * rooms is the next step's. A type is added or removed at once (like photos);
 * the prices are the step's draft and go to the rate card through the
 * wizard's save.
 */
export function RatesStep({ onSaved }: { onSaved: () => Promise<void> | void }) {
  const { colors } = useAppTheme();
  const hostel = useManagedHostel();
  const feeQuery = adminQuery.feeSchedules();
  const fees = useResource<FeeScheduleData>(feeQuery.load, { cacheKey: feeQuery.key, topics: feeQuery.topics });
  const [rents, setRents] = useState<Record<string, string>>({});
  const [feeDraft, setFeeDraft] = useState<Partial<Record<FeeField, string>>>({});
  const [saving, setSaving] = useState(false);
  const [naming, setNaming] = useState<string | null>(null);
  const { refresh } = hostel;
  const reread = useCallback(async () => {
    await Promise.all([refresh(), onSaved()]);
  }, [onSaved, refresh]);
  const { addPhotos, removePhoto, uploadingFor } = useHostelPhotoActions({ hostelName: hostel.data?.name, refresh: reread });
  const types = hostel.data?.roomConfigurations ?? [];
  const photos = hostel.data?.photos ?? [];
  const card = fees.data?.schedules.find((item) => item.standing === "upcoming") ?? fees.data?.schedules.find((item) => item.standing === "current");
  const savedRent = (roomType: string) => card?.rates.find((item) => (item.roomType ?? "").toLowerCase() === roomType.toLowerCase())?.monthlyAmount;
  const rentOf = (roomType: string) => rents[roomType] ?? String(savedRent(roomType) ?? "");
  const feeOf = (field: FeeField) => feeDraft[field] ?? (card?.[field] ? String(card[field]) : "");
  const digits = (text: string) => text.replace(/\D/g, "");
  const rates = types
    .filter((type) => Number(rentOf(type.roomType)) > 0)
    .map((type) => ({ monthlyAmount: Number(rentOf(type.roomType)), roomType: type.roomType }));
  const save = async () => {
    if (!rates.length) { toastError("Not saved", "Enter a monthly rent."); return false; }
    setSaving(true);
    try {
      const result = await saveKycRates({
        admissionFee: Number(feeOf("admissionFee")) || 0,
        depositAmount: Number(feeOf("depositAmount")) || 0,
        formFee: Number(feeOf("formFee")) || 0,
        rates,
      });
      if (result.nextMonth) toastSuccess("Saved", "Residents are already billed at the old price this month, so the new price starts next month.");
      setRents({});
      setFeeDraft({});
      await Promise.all([fees.reload(), hostel.reload(), onSaved()]);
      return true;
    } catch (error) { toastError("Not saved", readApiError(error)); return false; }
    finally { setSaving(false); }
  };
  useKycDraft({ dirty: Object.keys(rents).length + Object.keys(feeDraft).length > 0, busy: saving || Boolean(uploadingFor), save });
  const writeTypes = async (next: ManagedHostel["roomConfigurations"]) => {
    setSaving(true);
    try {
      const updated = await updateManagedHostel({ roomConfigurations: next });
      hostel.setData(() => updated);
      await Promise.all([fees.reload(), onSaved()]);
      return true;
    } catch (error) { toastError("Not saved", readApiError(error)); return false; }
    finally { setSaving(false); }
  };
  const addType = async (name: string) => {
    const roomType = name.trim();
    if (!roomType) return;
    if (types.some((type) => type.roomType.toLowerCase() === roomType.toLowerCase())) { toastError("Already added", roomType); return; }
    if (await writeTypes([...types, { bedsPerRoom: bedsForRoomType(roomType), mealInclusion: "Included", monthlyRent: 0, rooms: 0, roomType, vacantBeds: 0 }])) setNaming(null);
  };
  const removeType = (roomType: string) => openConfirm({
    confirmLabel: "Remove",
    destructive: true,
    message: "Its price and rooms go with it.",
    onConfirm: async () => {
      if (await writeTypes(types.filter((type) => type.roomType !== roomType))) {
        setRents((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== roomType)));
      }
    },
    title: `Remove ${roomTypeLabel(roomType)}?`,
  });

  if (hostel.loading || fees.loading) return <SkeletonCard rows={3} />;
  if (hostel.error || !hostel.data) return <ErrorState message={hostel.error ?? "Could not load your room types."} onRetry={hostel.reload} />;

  const unpicked = ROOM_TYPE_OPTIONS.filter((option) => !types.some((type) => type.roomType === option));

  return <View className="gap-4">
    <View className="flex-row flex-wrap gap-2">
      {unpicked.map((option) => <Pressable accessibilityLabel={`Add ${roomTypeLabel(option)}`} accessibilityRole="button" className="min-h-11 flex-row items-center gap-1.5 rounded-xl border border-border px-3 active:opacity-70" disabled={saving} key={option} onPress={() => void addType(option)}><Glyph color={colors.primary} name="add" size={16} /><Text variant="label">{roomTypeLabel(option)}</Text></Pressable>)}
      <Pressable accessibilityLabel="Add another room type" accessibilityRole="button" className="min-h-11 flex-row items-center gap-1.5 rounded-xl border border-dashed border-border px-3 active:opacity-70" disabled={saving} onPress={() => setNaming("")}><Glyph color={colors.primary} name="create" size={16} /><Text variant="label">Other</Text></Pressable>
    </View>
    {types.map((type) => {
      const beds = bedsForRoomType(type.roomType);
      const target = { kind: "ROOM", roomType: type.roomType } as const;
      const shots = photos.filter((photo) => photo.kind === "ROOM" && photo.roomType === type.roomType);
      return <Card className="gap-3" key={type.roomType}>
        <View className="flex-row items-center gap-3">
          <View className="h-10 w-10 items-center justify-center rounded-xl bg-brand-soft"><Glyph color={colors.primary} name="bed" size={20} /></View>
          <View className="flex-1"><Text variant="label">{roomTypeLabel(type.roomType)}</Text><Text variant="caption">{beds} {beds === 1 ? "bed" : "beds"} a room</Text></View>
          {savedRent(type.roomType) ? null : <Badge label="Not priced" tone="warning" />}
          <IconButton label={`Remove ${roomTypeLabel(type.roomType)}`} name="trash" onPress={() => removeType(type.roomType)} size="sm" />
        </View>
        <Input accessibilityLabel={`${roomTypeLabel(type.roomType)} rent`} keyboardType="number-pad" label="Rent / month" leading={<Glyph color={colors.mutedForeground} name="cash" size={18} />} onChangeText={(text) => setRents((current) => ({ ...current, [type.roomType]: digits(text) }))} placeholder="12000" value={rentOf(type.roomType)} variant="line" />
        <PhotoStrip busy={uploadingFor === targetKey(target)} disabled={Boolean(uploadingFor)} limit={PHOTO_LIMITS.ROOM} name={roomTypeLabel(type.roomType)} onAdd={(source) => void addPhotos(target, shots.length, source)} onRemove={removePhoto} photos={shots} />
      </Card>;
    })}
    {types.length ? <>
      <StepSection caption="Same for every room" title="Joining fees">
        <View className="flex-row gap-2">
          {FEE_FIELDS.map((item) => <View className="flex-1" key={item.field}>
            <Input keyboardType="number-pad" label={item.label} leading={<Glyph color={colors.mutedForeground} name={item.icon} size={18} />} onChangeText={(text) => setFeeDraft((current) => ({ ...current, [item.field]: digits(text) }))} placeholder="0" value={feeOf(item.field)} variant="line" />
          </View>)}
        </View>
      </StepSection>
    </> : null}
    <Sheet footer={<Button disabled={saving || !naming?.trim()} label={saving ? "Saving…" : "Add room type"} onPress={() => void addType(naming ?? "")} />} onClose={() => setNaming(null)} open={naming !== null} title="Other room type">
      {naming !== null ? <Input autoCapitalize="words" hint={naming.trim() ? `${bedsForRoomType(naming)} ${bedsForRoomType(naming) === 1 ? "bed" : "beds"} a room` : "Put the beds in the name: 6 Sharing"} label="Name" leading={<Glyph color={colors.mutedForeground} name="bed" size={18} />} onChangeText={setNaming} placeholder="6 Sharing" value={naming} variant="line" /> : null}
    </Sheet>
  </View>;
}
