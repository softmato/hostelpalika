import { useState } from "react";
import { View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Chip } from "@/components/ui/layout";
import { RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { SkeletonCard } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { Toggle } from "@/components/ui/toggle";
import { useResource } from "@/hooks/use-resource";
import { readApiError } from "@/lib/api-contract";
import { type Announcement, type FeatureFlags, getSiteFlags, saveSiteSection } from "@/lib/platform-admin-api";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Website Config › Feature Flags and Announcements — the two switches the
 * owner flips from a phone. Flags save on the tap (the whole section, as the
 * server replaces it); the announcement bar saves with its button. Longer copy
 * sections (SEO, legal, page content) stay on the web, where there is a keyboard.
 */

const FLAGS: { hint: string; key: keyof FeatureFlags; label: string }[] = [
  { hint: "Anyone can register a hostel from the site", key: "publicRegistration", label: "Hostel registration" },
  { hint: "Visitors can send a hostel an inquiry", key: "inquiries", label: "Inquiries" },
  { hint: "Residents can review their hostel", key: "reviews", label: "Reviews" },
  { hint: "Side-by-side hostel compare", key: "compare", label: "Compare" },
  { hint: "Electricians, plumbers… can apply", key: "serviceProviderSignup", label: "Service provider sign-up" },
];

const TONES: Announcement["tone"][] = ["info", "success", "warning"];

export default function SiteConfigScreen() {
  const config = useResource(getSiteFlags, { cacheKey: "platform:site-flags" });
  const [draft, setDraft] = useState<Announcement | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  const features = config.data?.features;
  const announcement = draft ?? config.data?.announcement ?? { enabled: false, link: "", linkLabel: "", message: "", tone: "info" as const };

  async function flip(key: keyof FeatureFlags, value: boolean) {
    if (!features) return;
    setSaving(key);
    const next = { ...features, [key]: value };
    config.setData((current) => (current ? { ...current, features: next } : current));
    try {
      await saveSiteSection("features", next);
    } catch (error) {
      config.setData((current) => (current ? { ...current, features } : current));
      toastError("Not saved", readApiError(error));
    } finally {
      setSaving(null);
    }
  }

  async function saveAnnouncement() {
    setSaving("announcement");
    try {
      await saveSiteSection("announcement", { ...announcement, message: announcement.message.trim() });
      toastSuccess(announcement.enabled ? "Announcement is live" : "Announcement saved");
      setDraft(null);
      config.refresh();
    } catch (error) {
      toastError("Not saved", readApiError(error));
    } finally {
      setSaving(null);
    }
  }

  const edit = (patch: Partial<Announcement>) => setDraft({ ...announcement, ...patch });

  return (
    <Screen header={<AppBar showBack title="Website config" />} onRefresh={config.refresh} refreshing={config.refreshing} scroll>
      {config.loading ? (
        <View className="gap-4">
          <SkeletonCard rows={5} />
          <SkeletonCard rows={3} />
        </View>
      ) : config.error || !features ? (
        <ErrorState message={config.error ?? "Site config could not be loaded."} onRetry={config.reload} />
      ) : (
        <View className="gap-5">
          <View>
            <SectionHeader subtitle="Saved as you switch" title="Features" />
            <Card padding="px-4 py-1">
              {FLAGS.map((flag, index) => (
                <View key={flag.key}>
                  {index > 0 ? <RowDivider /> : null}
                  <View className="flex-row items-center gap-3 py-3">
                    <View className="flex-1">
                      <Text className="font-semibold">{flag.label}</Text>
                      <Text className="text-xs" variant="muted">
                        {flag.hint}
                      </Text>
                    </View>
                    <Toggle
                      accessibilityLabel={flag.label}
                      disabled={saving === flag.key}
                      onChange={(value) => void flip(flag.key, value)}
                      value={features[flag.key]}
                    />
                  </View>
                </View>
              ))}
            </Card>
          </View>

          <View>
            <SectionHeader subtitle="The bar across the top of the website" title="Announcement" />
            <Card className="gap-4">
              <View className="flex-row items-center justify-between">
                <Text className="font-semibold">Show it</Text>
                <Toggle accessibilityLabel="Show the announcement" onChange={(enabled) => edit({ enabled })} value={announcement.enabled} />
              </View>
              <Input label="Message" maxLength={240} multiline onChangeText={(message) => edit({ message })} value={announcement.message} />
              <View className="flex-row flex-wrap gap-2">
                {TONES.map((tone) => (
                  <Chip key={tone} label={tone[0]!.toUpperCase() + tone.slice(1)} onPress={() => edit({ tone })} tone={announcement.tone === tone ? "brand" : "neutral"} />
                ))}
              </View>
              <Input autoCapitalize="none" keyboardType="url" label="Link (optional)" onChangeText={(link) => edit({ link })} placeholder="https://" value={announcement.link} />
              {announcement.link ? (
                <Input label="Link text" maxLength={40} onChangeText={(linkLabel) => edit({ linkLabel })} placeholder="Read more" value={announcement.linkLabel} />
              ) : null}
              <Button
                disabled={!draft || (announcement.enabled && !announcement.message.trim())}
                label="Save announcement"
                loading={saving === "announcement"}
                onPress={() => void saveAnnouncement()}
              />
            </Card>
          </View>
        </View>
      )}
    </Screen>
  );
}
