import { router } from "expo-router";
import { View } from "react-native";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Glyph, type GlyphName } from "@/components/ui/glyph";
import { Skeleton } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import type { BadgeTone } from "@/lib/status";
import type { ProviderApplication } from "@/lib/provider-api";
import { providerStatusPanel } from "@/lib/provider-status";

/**
 * Where a service provider application stands, drawn the same way everywhere.
 *
 * ## Why an applicant needs this on a screen they did not open for it
 *
 * A pending applicant is a `PUBLIC` account, so the app they are holding is the
 * ordinary browsing shell — hostels, community, saved. Nothing in it changed
 * when they submitted five steps of documents and a photograph of their face,
 * and the one screen that knew about their application was "Become a service
 * provider", which is the last page somebody who has *already applied* would
 * think to open. The honest reading of that app is that the application went
 * nowhere.
 *
 * So the state comes to them: a tile, the title, what happens next and how long
 * it takes. It is the same panel the website shows in place of its call to
 * action, and the copy is `lib/provider-status.ts` on both.
 *
 * ## The tile is tinted, and the tint is the state
 *
 * Amber while we are checking, red if it was refused, green once it is live.
 * Never colour alone — the title says the same thing in words, because the one
 * fact this card exists to deliver must survive a greyscale screen and a
 * colour-blind reader.
 */

const TILE_TINT: Record<BadgeTone, string> = {
  danger: "bg-destructive-soft",
  info: "bg-brand-soft",
  neutral: "bg-muted",
  success: "bg-success-soft",
  warning: "bg-warning-soft",
};

const TILE_INK: Record<
  BadgeTone,
  "destructive" | "mutedForeground" | "primary" | "success" | "warning"
> = {
  danger: "destructive",
  info: "primary",
  neutral: "mutedForeground",
  success: "success",
  warning: "warning",
};

export function ProviderStatusCard({
  application,
  /**
   * Draw the apply button when the state allows one.
   *
   * Off on the provider's own card tab, which is reached only by an approved
   * provider and where the button would never render anyway — and off on any
   * surface where a second call to action would compete with the screen's own.
   */
  showApply = true,
  /** A row into the Jobs tab, for a screen that is not already inside it. */
  showJobsLink = false,
  loading = false,
}: {
  application: ProviderApplication | null;
  loading?: boolean;
  showApply?: boolean;
  showJobsLink?: boolean;
}) {
  const { colors } = useAppTheme();

  if (loading) {
    /*
     * Inert rather than absent. The lookup resolves a beat after the first
     * frame, and a card that appears late shifts the page under whoever was
     * already reading it — the same reason the landing screen draws a
     * placeholder instead of nothing.
     */
    return (
      <Card className="gap-3">
        <View className="flex-row items-center gap-3">
          <Skeleton height={40} radius={12} width={40} />
          <View className="flex-1 gap-2">
            <Skeleton height={14} width="60%" />
            <Skeleton height={11} width="35%" />
          </View>
        </View>
        <Skeleton height={11} />
        <Skeleton height={11} width="80%" />
      </Card>
    );
  }

  const panel = providerStatusPanel(application);

  return (
    <Card className="gap-3">
      <View className="flex-row items-center gap-3">
        <View
          className={`h-10 w-10 items-center justify-center rounded-xl ${TILE_TINT[panel.tone]}`}
        >
          <Glyph
            color={colors[TILE_INK[panel.tone]]}
            name={panel.icon as GlyphName}
            size={19}
          />
        </View>

        <View className="flex-1">
          <Text variant="subtitle">{panel.title}</Text>
          <Text variant="caption">Service provider application</Text>
        </View>
      </View>

      <Text className="leading-6" variant="muted">
        {panel.body}
      </Text>

      {showApply && panel.canApply ? (
        <Button
          label={application ? "Start a new application" : "Apply as a service provider"}
          onPress={() => router.push("/service-providers/apply")}
        />
      ) : null}

      {showJobsLink && panel.showJobs ? (
        <Button label="Go to your jobs" onPress={() => router.push("/(provider)")} />
      ) : null}
    </Card>
  );
}
