import { useState } from "react";
import { View } from "react-native";
import { useKycDraft } from "@/components/manage/kyc-draft";
import { Glyph } from "@/components/ui/glyph";
import { Input } from "@/components/ui/input";
import { useAppTheme } from "@/hooks/use-app-theme";
import { type HostelKyc } from "@/lib/admin-api";
import { ChoiceChips } from "@/components/ui/choice-chips";
import { updateManagedHostel } from "@/lib/admin-manage-api";
import { readApiError } from "@/lib/api-contract";
import { HOSTEL_TYPES } from "@/lib/hostel-registration";
import { toastError } from "@/lib/toast";

/** Who lives here and the address: the quick sign-up filed a name only. */
export function DetailsStep({ data, onSaved }: { data: HostelKyc; onSaved: () => Promise<void> | void }) {
  const { colors } = useAppTheme();
  const saved = { address: data.details?.address ?? "", area: data.details?.area ?? "", city: data.details?.city || "Kathmandu", hostelType: data.details?.hostelType ?? "CO_LIVING" };
  const [draft, setDraft] = useState<typeof saved | null>(null);
  const [saving, setSaving] = useState(false);
  const [tried, setTried] = useState(false);
  const form = draft ?? saved;
  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  const set = (patch: Partial<typeof saved>) => setDraft({ ...form, ...patch });
  const save = async () => {
    if (form.area.trim().length < 2 || form.city.trim().length < 2) {
      setTried(true);
      return false;
    }
    setSaving(true);
    try {
      await updateManagedHostel({ hostelType: form.hostelType, location: { address: form.address.trim(), area: form.area.trim(), city: form.city.trim() } });
      await onSaved();
      setDraft(null);
      return true;
    } catch (error) { toastError("Not saved", readApiError(error)); return false; }
    finally { setSaving(false); }
  };
  useKycDraft({ dirty, busy: saving, save });
  return <View className="gap-4">
    <ChoiceChips columns={3} label="Who lives here" onToggle={(hostelType) => set({ hostelType })} options={HOSTEL_TYPES} value={form.hostelType as (typeof HOSTEL_TYPES)[number]["value"]} />
    <Input autoCapitalize="words" leading={<Glyph color={colors.mutedForeground} name="business" size={18} />} variant="line" autoComplete="postal-address-locality" error={tried && form.city.trim().length < 2 ? "Enter the city" : undefined} label="City" onChangeText={(city) => set({ city })} value={form.city} />
    <Input autoCapitalize="words" leading={<Glyph color={colors.mutedForeground} name="map" size={18} />} variant="line" error={tried && form.area.trim().length < 2 ? "Enter the area" : undefined} label="Area" onChangeText={(area) => set({ area })} placeholder="Baneshwor" value={form.area} />
    <Input autoCapitalize="sentences" leading={<Glyph color={colors.mutedForeground} name="location" size={18} />} variant="line" autoComplete="street-address" label="Address" onChangeText={(address) => set({ address })} placeholder="Street, near a landmark" value={form.address} />
  </View>;
}
