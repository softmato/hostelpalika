import { useCallback, useState } from "react";
import { View } from "react-native";

import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { Toggle } from "@/components/ui/toggle";
import { useResource } from "@/hooks/use-resource";
import {
  getShortStaySettings,
  saveShortStaySettings,
  type ShortStaySettings,
} from "@/lib/admin-bookings-api";
import { readApiError } from "@/lib/api-contract";
import { formatMoney } from "@/lib/format";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Short stays on Bookings → Settings: on or off, the fewest nights and a daily
 * rate per room type, never below that room's floor. Same rules as the web panel.
 */

function ShortStaysForm({ onSaved, settings }: { onSaved: () => void; settings: ShortStaySettings }) {
  const [enabled, setEnabled] = useState(settings.enabled);
  const [minNights, setMinNights] = useState(String(settings.minNights));
  const [rates, setRates] = useState<Record<string, string>>(() =>
    Object.fromEntries(settings.rooms.map((room) => [room.roomType, room.dailyRate ? String(room.dailyRate) : ""])),
  );
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);

    try {
      await saveShortStaySettings({
        enabled,
        minNights: Number(minNights),
        rates: settings.rooms
          .filter((room) => Number(rates[room.roomType]) > 0)
          .map((room) => ({ dailyRate: Number(rates[room.roomType]), roomType: room.roomType })),
      });
      toastSuccess("Short stays saved");
      onSaved();
    } catch (error) {
      toastError("Not saved", readApiError(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="gap-3">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="font-semibold text-foreground" variant={null}>
          Take short stays
        </Text>
        <Toggle accessibilityLabel="Take short stays" onChange={setEnabled} value={enabled} />
      </View>
      <Input keyboardType="number-pad" label="Fewest nights" onChangeText={setMinNights} value={minNights} />
      {settings.rooms.map((room) => (
        <Input
          editable={Boolean(room.floor)}
          hint={
            room.floor && room.monthlyRent
              ? `${formatMoney(room.monthlyRent)} a month · at least ${formatMoney(room.floor)} a night`
              : "Set a monthly rent on the rate card first"
          }
          key={room.roomType}
          keyboardType="number-pad"
          label={`${room.roomType} · a night`}
          onChangeText={(value) => setRates((current) => ({ ...current, [room.roomType]: value }))}
          value={rates[room.roomType] ?? ""}
        />
      ))}
      <Text variant="caption">
        {`Up to ${settings.limits.maxNights} nights. The guest pays us the nights and the booking fee upfront. You get ${settings.limits.hostelSharePercent}% of the nights once they check in by card scan. No monthly rent is billed.`}
      </Text>
      <Button label="Save" loading={saving} onPress={() => void save()} />
    </Card>
  );
}

export function ShortStaysCard() {
  const settings = useResource<ShortStaySettings>(useCallback(() => getShortStaySettings(), []), {
    cacheKey: "hostel-short-stays",
  });

  if (settings.loading || settings.error || !settings.data) {
    return null;
  }

  return (
    <View>
      <SectionHeader subtitle="Stays of a few nights, paid to us upfront" title="Short stays" />
      <ShortStaysForm key={JSON.stringify(settings.data)} onSaved={settings.refresh} settings={settings.data} />
    </View>
  );
}
