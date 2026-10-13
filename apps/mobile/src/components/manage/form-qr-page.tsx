import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { Image } from "expo-image";
import { router } from "expo-router";
import { Pressable, Share, View } from "react-native";

import { Text } from "@/components/ui/text";
import { useResource } from "@/hooks/use-resource";
import type { AdmissionFormLink, AdmissionForms } from "@/lib/admission-form-api";
import { adminQuery } from "@/lib/admin-queries";
import { toastSuccess } from "@/lib/toast";

/**
 * The scanner's second page: the hostel's admission form as a QR.
 *
 * Shown to somebody standing at the desk who has no ID card. They scan it with
 * their own phone camera, it opens in the app if they have it and in the
 * browser if not, they fill the form, and it lands on the Residents tab with a
 * bell. A white card on the black ground, the hostel's name in a green band
 * across its top — the way the reference apps draw "My QR".
 */
export function FormQrPage() {
  const linkQuery = adminQuery.admissionFormLink();
  const link = useResource<AdmissionFormLink>(linkQuery.load, {
    cacheKey: linkQuery.key,
    topics: linkQuery.topics,
  });
  const formsQuery = adminQuery.admissionForms();
  const forms = useResource<AdmissionForms>(formsQuery.load, {
    cacheKey: formsQuery.key,
    topics: formsQuery.topics,
  });
  const data = link.data;
  const waiting = forms.data?.waiting ?? 0;

  return (
    <View className="flex-1 items-center justify-between px-6">
      <View className="w-full max-w-sm items-center gap-5">
        <View className="w-full overflow-hidden rounded-3xl bg-white">
          <View className="items-center gap-0.5 bg-primary px-5 py-3">
            <Text className="text-xs font-bold uppercase tracking-wide text-primary-foreground/80">
              Admission form
            </Text>
            <Text className="text-center text-lg font-bold text-primary-foreground" numberOfLines={1}>
              {data?.hostelName || " "}
            </Text>
          </View>

          <View className="items-center gap-3 px-5 pb-5 pt-5">
            {data?.qrDataUrl ? (
              <Image
                accessibilityLabel="QR code for the admission form"
                source={{ uri: data.qrDataUrl }}
                style={{ height: 220, opacity: data.enabled ? 1 : 0.3, width: 220 }}
              />
            ) : (
              // The QR's own shape while it loads — or the reason it did not.
              <View className="h-[220px] w-[220px] items-center justify-center rounded-2xl bg-neutral-100 px-4">
                {link.error ? (
                  <Text className="text-center text-sm text-neutral-600">{link.error}</Text>
                ) : null}
              </View>
            )}
            <Text className="text-center text-sm font-semibold text-neutral-900">
              Scan with your phone camera to fill the form
            </Text>
            {data ? (
              <Text className="text-center text-xs text-neutral-500" numberOfLines={1} selectable>
                {data.url}
              </Text>
            ) : null}
          </View>
        </View>

        {data ? (
          <View className="flex-row gap-3">
            <GlassAction
              icon="share-social-outline"
              label="Share link"
              onPress={() =>
                void Share.share({
                  message: `Fill the admission form for ${data.hostelName}:\n${data.url}`,
                }).catch(() => null)
              }
            />
            <GlassAction
              icon="copy-outline"
              label="Copy link"
              onPress={async () => {
                await Clipboard.setStringAsync(data.url);
                toastSuccess("Link copied");
              }}
            />
          </View>
        ) : null}
      </View>

      {waiting > 0 ? (
        <Pressable
          accessibilityRole="button"
          className="w-full max-w-sm flex-row items-center gap-3 rounded-2xl border border-white/25 bg-white/10 px-4 py-3.5 active:opacity-70"
          onPress={() => router.push("/manage/applications")}
        >
          <Ionicons color="#ffffff" name="document-text-outline" size={20} />
          <Text className="flex-1 text-sm font-semibold text-white">
            {waiting === 1 ? "1 form waiting for a bed" : `${waiting} forms waiting for a bed`}
          </Text>
          <Ionicons color="rgba(255,255,255,0.7)" name="chevron-forward" size={18} />
        </Pressable>
      ) : (
        <Text className="text-center text-xs text-white/55">
          Filled forms appear on the Residents tab, and you get a notification.
        </Text>
      )}
    </View>
  );
}

function GlassAction({
  icon,
  label,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      className="flex-row items-center gap-2 rounded-full border border-white/25 bg-white/10 px-4 py-2.5 active:opacity-70"
      onPress={onPress}
    >
      <Ionicons color="#ffffff" name={icon} size={16} />
      <Text className="text-sm font-semibold text-white">{label}</Text>
    </Pressable>
  );
}
