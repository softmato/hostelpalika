import { Image } from "expo-image";
import { useLocalSearchParams } from "expo-router";
import { View } from "react-native";

import { ShareReceiptGuide } from "@/components/share-receipt-guide";
import { AppBar } from "@/components/ui/app-bar";
import { Card } from "@/components/ui/card";
import { Screen } from "@/components/ui/screen";
import { Segmented } from "@/components/ui/segmented";
import { SkeletonCard } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { GUIDE_LANG_OPTIONS, useGuide, useGuideLang } from "@/hooks/use-guide";
import { GUIDE_ROLES, type Guide, type GuidePicture } from "@/lib/guide-api";

/** One picture, full width; cached by name so a fresh signature never downloads it again. */
function Picture({ caption, picture }: { caption: string; picture: GuidePicture }) {
  return (
    <View className="overflow-hidden rounded-2xl border border-border bg-muted/30">
      <Image
        accessibilityLabel={caption}
        contentFit="contain"
        source={{ cacheKey: picture.name ? `guide:${picture.name}` : undefined, uri: picture.src }}
        style={{ aspectRatio: 3 / 2, width: "100%" }}
        transition={0}
      />
      <Text className="border-t border-border bg-background px-3 py-2 text-xs text-muted-foreground">{caption}</Text>
    </View>
  );
}

function AccessTable({ guide, ne }: { guide: Guide; ne: boolean }) {
  const word = (v: string) => (ne ? (guide.ne.access.cells[v] ?? v) : v);
  return (
    <Card>
      {guide.access.map((row, i) => (
        <View className={i ? "border-t border-border py-3" : "pb-3"} key={row.area}>
          <Text className="font-semibold text-foreground">{ne ? (guide.ne.access.areas[row.area] ?? row.area) : row.area}</Text>
          <Text className="mt-1 text-sm text-muted-foreground">
            {GUIDE_ROLES.map((r) => `${ne ? (guide.ne.access.roles[r] ?? r) : r}: ${word(row.cells[r])}`).join(" · ")}
          </Text>
        </View>
      ))}
    </Card>
  );
}

function Trouble({ guide, ne }: { guide: Guide; ne: boolean }) {
  return (
    <Card>
      {guide.trouble.map((t, i) => (
        <View className={i ? "border-t border-border py-3" : "pb-3"} key={t.problem}>
          <Text className="font-semibold text-foreground">{(ne && guide.ne.trouble[i]?.problem) || t.problem}</Text>
          <Text className="mt-1 text-sm text-foreground/80">{(ne && guide.ne.trouble[i]?.fix) || t.fix}</Text>
        </View>
      ))}
    </Card>
  );
}

/** One chapter: the pictures first, then the words, in the chosen language. */
export default function GuideChapterScreen() {
  const { chapter: id } = useLocalSearchParams<{ chapter: string }>();
  const guide = useGuide();
  const [lang, setLang] = useGuideLang();
  const g = guide.data?.guide;
  const c = g?.groups.flatMap((x) => x.chapters).find((x) => x.id === id);
  const ne = lang === "ne" && c ? g?.ne.chapters[c.id] : undefined;
  const header = <AppBar showBack title={ne?.title ?? c?.title ?? "Guide"} />;

  if (guide.loading) {
    return (
      <Screen header={header} scroll>
        <SkeletonCard rows={6} />
      </Screen>
    );
  }
  if (guide.error || !g) {
    return (
      <Screen header={header}>
        <ErrorState message={guide.error ?? "The guide could not be loaded."} onRetry={guide.reload} />
      </Screen>
    );
  }
  if (!c) {
    return (
      <Screen header={header}>
        <EmptyState description="This chapter is not part of your guide." title="Not found" />
      </Screen>
    );
  }

  const body = ne?.body ?? c.body;
  const points = ne?.points ?? c.points;
  const steps = ne?.steps ?? c.steps;
  const note = ne?.note ?? c.note;

  return (
    <Screen header={header} onRefresh={guide.refresh} refreshing={guide.refreshing} scroll>
      <View className="gap-4">
        <View className="flex-row items-start justify-between gap-3">
          <Text className="flex-1 text-sm text-muted-foreground">{ne?.summary ?? c.summary}</Text>
          <Segmented onChange={setLang} options={GUIDE_LANG_OPTIONS} value={lang} />
        </View>

        {c.flow ? <Picture caption={(ne && g.ne.chapters[c.id]?.flow) || c.flow.caption} picture={c.flow} /> : null}
        {c.widget === "share-receipt" ? <ShareReceiptGuide /> : null}
        {c.widget === "access-table" ? <AccessTable guide={g} ne={lang === "ne"} /> : null}
        {c.widget === "troubleshooting" ? <Trouble guide={g} ne={lang === "ne"} /> : null}
        {c.shot ? <Picture caption={(ne && g.ne.chapters[c.id]?.shot) || c.shot.caption} picture={c.shot} /> : null}

        {body?.map((p) => (
          <Text className="text-[15px] leading-6 text-foreground/85" key={p}>
            {p}
          </Text>
        ))}
        {points ? (
          <View className="gap-2">
            {points.map((pt) => (
              <View className="flex-row gap-3" key={pt}>
                <View className="mt-2 size-1.5 rounded-full bg-primary" />
                <Text className="flex-1 text-[15px] leading-6 text-foreground/85">{pt}</Text>
              </View>
            ))}
          </View>
        ) : null}
        {steps ? (
          <View className="gap-3">
            {steps.map((s, i) => (
              <View className="flex-row gap-3" key={s}>
                <View className="size-6 items-center justify-center rounded-full bg-primary/10">
                  <Text className="text-xs font-bold text-primary">{i + 1}</Text>
                </View>
                <Text className="flex-1 text-[15px] leading-6 text-foreground/85">{s}</Text>
              </View>
            ))}
          </View>
        ) : null}
        {note ? (
          <View className="rounded-xl border-l-4 border-primary bg-primary/5 px-4 py-3">
            <Text className="text-[15px] leading-6 text-foreground/85">
              <Text className="font-semibold text-foreground">{note.title}. </Text>
              {note.body}
            </Text>
          </View>
        ) : null}
      </View>
    </Screen>
  );
}
