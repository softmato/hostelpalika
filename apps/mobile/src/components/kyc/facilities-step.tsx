import { useState } from "react";
import { Pressable, View } from "react-native";
import { useKycDraft } from "@/components/manage/kyc-draft";
import { Glyph, type GlyphName } from "@/components/ui/glyph";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { updateManagedHostel } from "@/lib/admin-manage-api";
import { readApiError } from "@/lib/api-contract";
import { FACILITY_OPTIONS } from "@/lib/hostel-registration";
import { toastError } from "@/lib/toast";

const FACILITY_ICONS: Record<string, GlyphName> = {
  WiFi: "wifi", "Hot water": "water", Parking: "car", Laundry: "shirt", Gym: "barbell", "Study table": "reader", "Attached bathroom": "water", AC: "snow", CCTV: "videocam", "Power backup": "battery-charging", Kitchen: "restaurant", "Common room": "people",
};
export function FacilitiesStep({ onSaved, saved }: { onSaved: () => Promise<void> | void; saved: string[] }) {
  const { colors } = useAppTheme();
  const [draft, setDraft] = useState<string[] | null>(null);
  const [custom, setCustom] = useState("");
  const [saving, setSaving] = useState(false);
  const picked = draft ?? saved;
  const options = [...new Set([...FACILITY_OPTIONS, ...saved, ...picked])];
  const addCustom = () => {
    const name = custom.trim();
    if (!name) return;
    const known = options.find((option) => option.toLowerCase() === name.toLowerCase());
    if (!picked.includes(known ?? name)) setDraft([...picked, known ?? name]);
    setCustom("");
  };
  const dirty = [...picked].sort().join("|") !== [...saved].sort().join("|");
  const save = async () => {
    setSaving(true);
    try { await updateManagedHostel({ facilities: picked }); await onSaved(); setDraft(null); return true; }
    catch (error) { toastError("Not saved", readApiError(error)); return false; }
    finally { setSaving(false); }
  };
  useKycDraft({ dirty, busy: saving, save });
  return <View className="gap-4"><View className="flex-row flex-wrap gap-3">{options.map(option => {
    const selected = picked.includes(option);
    return <Pressable key={option} accessibilityRole="checkbox" accessibilityState={{ checked: selected }} onPress={() => setDraft(selected ? picked.filter(item => item !== option) : [...picked, option])} className={`min-h-20 w-[48%] flex-row items-center gap-2 rounded-2xl border p-3 ${selected ? "border-primary/30 bg-brand-soft" : "border-border"}`}>
      <Glyph name={FACILITY_ICONS[option] ?? "checkmark-circle"} color={selected ? colors.primary : colors.foreground} size={24} /><Text className="flex-1" variant="label">{option === "WiFi" ? "Wi-Fi" : option}</Text>{selected ? <Glyph name="checkmark-circle" color={colors.primary} size={16} /> : null}
    </Pressable>;
  })}</View>
    <View className="flex-row items-end gap-2">
      <View className="flex-1"><Input autoCapitalize="sentences" label="Add custom facility" leading={<Glyph color={colors.mutedForeground} name="add" size={18} />} onChangeText={setCustom} onSubmitEditing={addCustom} placeholder="Rooftop garden" returnKeyType="done" value={custom} variant="line" /></View>
      <Button disabled={!custom.trim()} label="Add" onPress={addCustom} size="md" variant="outline" />
    </View>
  </View>;
}
