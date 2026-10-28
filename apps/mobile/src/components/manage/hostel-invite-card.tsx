import * as Clipboard from "expo-clipboard";
import { useCallback } from "react";
import { Linking, Pressable, Share, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Glyph } from "@/components/ui/glyph";
import { Qr } from "@/components/ui/qr";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import type { HostelInviteOverview } from "@/lib/admin-manage-api";
import { toastSuccess } from "@/lib/toast";
import { PLATFORM_NAME } from "@hostel/brand/brand";

export function inviteMessage(data: HostelInviteOverview) {
  return [
    `We run our hostel on ${PLATFORM_NAME}.`,
    data.theyGet.text
      ? `Register yours with our code ${data.code} and get ${data.theyGet.text} extra, free:`
      : `Register yours with our code ${data.code}:`,
    data.link,
  ].join(" ");
}

/**
 * The hostel's invite, ready to hand over: a QR of the registration link to
 * scan across the desk, the code, the three ways to send it, and what each side
 * gets when the invited hostel goes live.
 */
export function HostelInviteCard({ data }: { data: HostelInviteOverview }) {
  const { colors } = useAppTheme();

  const copy = useCallback(async (value: string, label: string) => {
    await Clipboard.setStringAsync(value);
    toastSuccess(label);
  }, []);

  const share = useCallback(async () => {
    try {
      await Share.share({ message: inviteMessage(data) });
    } catch {
      // Dismissed. The code is on screen and copyable.
    }
  }, [data]);

  const whatsapp = useCallback(() => {
    void Linking.openURL(`https://wa.me/?text=${encodeURIComponent(inviteMessage(data))}`).catch(
      () => void share(),
    );
  }, [data, share]);

  return (
    <View className="gap-3">
      <Card className="items-center gap-3">
        <Text variant="label">Scan to register a hostel</Text>
        <View className="rounded-2xl border border-border p-2">
          <Qr size={188} text={data.link} />
        </View>

        <Pressable
          accessibilityHint="Copies the code"
          accessibilityLabel={`Referral code ${data.code}`}
          accessibilityRole="button"
          className="min-h-11 flex-row items-center gap-2 rounded-full bg-brand-soft px-4 active:opacity-70"
          onPress={() => void copy(data.code, "Code copied")}
        >
          <Text className="text-lg font-bold tracking-widest text-primary">{data.code}</Text>
          <Glyph color={colors.primary} name="copy" size={16} />
        </Pressable>

        <Button className="w-full" icon="share-social" label="Share link" onPress={() => void share()} />
        <View className="w-full flex-row gap-2">
          <Button className="flex-1" icon="chatbubble" label="WhatsApp" onPress={whatsapp} variant="outline" />
          <Button
            className="flex-1"
            icon="link"
            label="Copy link"
            onPress={() => void copy(data.link, "Link copied")}
            variant="outline"
          />
        </View>
      </Card>

      <View className="flex-row gap-3">
        <Reward glyph="gift" label="They get" value={data.theyGet.text || "Nothing extra"} />
        <Reward glyph="sparkles" label="You get, per hostel" value={data.youGet.text || "Nothing extra"} />
      </View>
    </View>
  );
}

function Reward({ glyph, label, value }: { glyph: "gift" | "sparkles"; label: string; value: string }) {
  const { colors } = useAppTheme();

  return (
    <Card className="flex-1 flex-row items-center gap-3 p-3">
      <View className="h-10 w-10 items-center justify-center rounded-full bg-brand-soft">
        <Glyph color={colors.primary} name={glyph} size={20} />
      </View>
      <View className="flex-1">
        <Text variant="caption">{label}</Text>
        <Text numberOfLines={2} variant="label">
          {value}
        </Text>
      </View>
    </Card>
  );
}
