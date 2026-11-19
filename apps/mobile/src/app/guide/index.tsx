import { router } from "expo-router";
import { View } from "react-native";

import { MenuGroup, MenuGroups, MenuRow } from "@/components/more-menu";
import { AppBar } from "@/components/ui/app-bar";
import type { GlyphName } from "@/components/ui/glyph";
import { Screen } from "@/components/ui/screen";
import { Segmented } from "@/components/ui/segmented";
import { SkeletonCard } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { GUIDE_LANG_OPTIONS, useGuide, useGuideLang } from "@/hooks/use-guide";

/** One icon per part, so each reads as its own section at a glance. */
const GROUP_ICON: Record<string, GlyphName> = {
  connects: "reader",
  cook: "restaurant",
  finance: "stats-chart",
  guardian: "heart",
  owner: "business",
  payments: "wallet",
  reference: "help-circle",
  resident: "person",
  residents: "people",
  staff: "shield-checkmark",
  start: "sparkles",
  visitor: "map",
  warden: "shield-checkmark",
};

/**
 * The user guide, as this account may read it (`GET /api/v1/guide`): the parts
 * for their role, each chapter a row. Nothing of the guide ships in the app.
 */
export default function GuideScreen() {
  const guide = useGuide();
  const [lang, setLang] = useGuideLang();
  const header = <AppBar showBack title="Guide" />;

  if (guide.loading) {
    return (
      <Screen header={header} scroll>
        <View className="gap-3">
          <SkeletonCard rows={3} />
          <SkeletonCard rows={4} />
          <SkeletonCard rows={3} />
        </View>
      </Screen>
    );
  }

  if (guide.error || !guide.data) {
    return (
      <Screen header={header}>
        <ErrorState message={guide.error ?? "The guide could not be loaded."} onRetry={guide.reload} />
      </Screen>
    );
  }

  const { guide: g, updatedAt, version } = guide.data;

  return (
    <Screen header={header} onRefresh={guide.refresh} refreshing={guide.refreshing} scroll>
      <View className="gap-4">
        <View className="flex-row items-center justify-between gap-3">
          <Text className="text-xs text-muted-foreground">
            v{version} · {updatedAt}
          </Text>
          <Segmented onChange={setLang} options={GUIDE_LANG_OPTIONS} value={lang} />
        </View>
        <MenuGroups>
          {g.groups.map((group) => (
            <MenuGroup key={group.slug} title={lang === "ne" ? (g.ne.groups[group.slug]?.label ?? group.label) : group.label}>
              {group.chapters.map((c) => {
                const ne = lang === "ne" ? g.ne.chapters[c.id] : undefined;
                return (
                  <MenuRow
                    icon={GROUP_ICON[group.slug] ?? "book"}
                    key={c.id}
                    onPress={() => router.push({ params: { chapter: c.id }, pathname: "/guide/[chapter]" })}
                    subtitle={ne?.summary ?? c.summary}
                    title={ne?.title ?? c.title}
                  />
                );
              })}
            </MenuGroup>
          ))}
        </MenuGroups>
      </View>
    </Screen>
  );
}
