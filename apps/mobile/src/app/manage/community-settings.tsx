import { useCallback } from "react";

import { AppBar } from "@/components/ui/app-bar";
import { Card } from "@/components/ui/card";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { SkeletonCard } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Toggle } from "@/components/ui/toggle";
import { useResource } from "@/hooks/use-resource";
import { type CommunitySettings, updateCommunitySettings } from "@/lib/admin-manage-api";
import { type AdminSettingsData, adminQuery } from "@/lib/admin-queries";
import { readApiError } from "@/lib/api-contract";
import { toastError } from "@/lib/toast";

/**
 * Settings → Community. Its own screen so Settings stays a list of labels
 * (field review, 2026-10-27). Reads the same cached `admin:settings` answer
 * Settings does, so it opens painted.
 */
export default function CommunitySettingsScreen() {
  const query = adminQuery.settings();
  const settings = useResource<AdminSettingsData>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });
  const { setData } = settings;
  const community = settings.data?.community ?? null;

  const save = useCallback(
    async (input: Partial<CommunitySettings>) => {
      try {
        const next = await updateCommunitySettings(input);

        setData((current) => (current ? { ...current, community: next } : current));
      } catch (error) {
        toastError("Could not change that", readApiError(error));
      }
    },
    [setData],
  );

  const header = <AppBar accent centerTitle showBack title="Community" />;

  if (settings.loading) {
    return (
      <Screen header={header}>
        <SkeletonCard rows={2} />
      </Screen>
    );
  }

  if (settings.error || !community) {
    return (
      <Screen header={header}>
        <ErrorState
          message={settings.error ?? "Only the hostel owner can change this."}
          onRetry={settings.reload}
        />
      </Screen>
    );
  }

  return (
    <Screen header={header} onRefresh={settings.refresh} refreshing={settings.refreshing} scroll>
      <Card padding="px-4 py-1">
        <ListRow
          icon="chatbubbles"
          right={
            <Toggle
              accessibilityLabel="Community enabled"
              onChange={(enabled) => void save({ enabled })}
              value={community.enabled}
            />
          }
          subtitle="Residents post on the platform-wide board"
          title="Community"
        />
        <RowDivider inset />
        <ListRow
          icon="shield-checkmark"
          right={
            <Toggle
              accessibilityLabel="Profanity filter enabled"
              onChange={(profanityFilterEnabled) => void save({ profanityFilterEnabled })}
              value={community.profanityFilterEnabled}
            />
          }
          subtitle="Flagged posts wait for a moderator"
          title="Profanity filter"
        />
      </Card>
    </Screen>
  );
}
