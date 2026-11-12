import { useManagedHostel } from "@/components/kyc/use-managed-hostel";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { PinPickerModal, PinPreview } from "@/components/hostel-pin-picker";
import { useKycDraft } from "@/components/manage/kyc-draft";
import { Glyph } from "@/components/ui/glyph";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SkeletonCard } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { type GeocodeHit, geocodeHostelLocation, updateManagedHostel } from "@/lib/admin-manage-api";
import { readApiError } from "@/lib/api-contract";
import { requestDeviceLocation } from "@/lib/location";
import { toastError } from "@/lib/toast";

/**
 * The pin, shown, then moved by search: a place name, a pasted Google Maps link
 * or a raw `lat,lng` — `profile/geocode` reads all three, and the pasted link is
 * the common case on a phone. A picked place is the owner's own pin (`MANUAL`),
 * which is what stops the server re-geocoding it back to the area's centre.
 */
export function LocationStep({ onSaved }: { onSaved: () => Promise<void> | void }) {
  const { colors } = useAppTheme();
  const hostel = useManagedHostel();
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);
  const [locating, setLocating] = useState(false);
  const [selected, setSelected] = useState<{ lat: number; lng: number; hit?: GeocodeHit } | null>(null);
  const location = hostel.data?.location;
  const savedPin = location?.lat != null && location.lng != null ? { lat: location.lat, lng: location.lng } : null;
  const pin = selected ?? savedPin;
  const placed = location?.locationSource === "MANUAL";
  // A guessed pin the owner leaves as it is gets confirmed by Save & next.
  const answer = selected ?? (placed ? null : savedPin);
  const save = async () => {
    if (!answer || !location) return false;
    setSaving(true);
    try {
      const next = await updateManagedHostel({ location: {
        address: location.address ? undefined : selected?.hit?.address,
        area: location.area ? undefined : selected?.hit?.area,
        city: location.city ? undefined : selected?.hit?.city,
        province: location.province ? undefined : selected?.hit?.province,
        lat: answer.lat, lng: answer.lng, locationSource: "MANUAL",
      } });
      hostel.setData(() => next);
      await onSaved(); setSelected(null); return true;
    } catch (error) { toastError("Not saved", readApiError(error)); return false; }
    finally { setSaving(false); }
  };
  useKycDraft({ dirty: answer !== null, busy: saving || locating, save });
  // The team portal's "Use my location": the phone's fix becomes the pin, and the
  // address it sits on fills only the fields the listing does not have yet.
  const locateMe = async () => {
    setLocating(true);
    try {
      const outcome = await requestDeviceLocation();
      if (outcome.kind !== "granted") {
        toastError("Location is off", outcome.kind === "denied" ? "Allow location for the app, or move the pin." : "Could not get a fix. Try again outside, or move the pin.");
        return;
      }
      const [hit] = await geocodeHostelLocation(outcome.coordinates).catch(() => []);
      setSelected({ ...outcome.coordinates, hit });
    } finally { setLocating(false); }
  };
  if (hostel.loading) return <SkeletonCard rows={3} />;
  if (hostel.error || !location) return <ErrorState message={hostel.error ?? "Could not load map."} onRetry={hostel.reload} />;
  return <View className="gap-4">
    {pin ? <>
      <Pressable accessibilityLabel="Move the pin" accessibilityRole="button" className="h-64 overflow-hidden rounded-2xl border border-border" onPress={() => setPicking(true)}>
        <PinPreview key={`${pin.lat},${pin.lng}`} pin={pin} />
      </Pressable>
      <View className="flex-row items-center gap-2">
        <Glyph color={colors.foreground} name="location" size={20} />
        <Text className="flex-1" numberOfLines={1} variant="subtitle">{[location.area, location.city].filter(Boolean).join(", ") || "Your hostel"}</Text>
        <Badge label={placed && !selected ? "Placed by you" : "Not saved"} tone={placed && !selected ? "success" : "warning"} />
      </View>
    </> : <Card className="items-center gap-2 py-8"><Glyph name="location" size={36} color={colors.primary} /><Text variant="muted">No pin yet</Text></Card>}
    <Button icon="locate" label={locating ? "Finding you…" : "Use my location"} disabled={locating} onPress={() => void locateMe()} variant="outline" />
    <Button icon="location" label={pin ? "Move pin" : "Find on map"} variant="outline" onPress={() => setPicking(true)} />
    <PinPickerModal
      initial={pin}
      onClose={() => setPicking(false)}
      onPick={(next) => { setSelected(next); setPicking(false); }}
      open={picking}
      search={geocodeHostelLocation}
    />
  </View>;
}
