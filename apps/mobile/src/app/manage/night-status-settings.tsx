import { NightStatusPromptCard } from "@/components/night-status-prompt-card";
import { AppBar } from "@/components/ui/app-bar";
import { Screen } from "@/components/ui/screen";
import { SkeletonCard } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { useResource } from "@/hooks/use-resource";
import { type AdminSettingsData, adminQuery } from "@/lib/admin-queries";

/** Settings → Night status: the nightly prompt's switch, hour and repeat. */
export default function NightStatusSettingsScreen() {
  const query = adminQuery.settings();
  const settings = useResource<AdminSettingsData>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });
  const nightStatus = settings.data?.attendance?.nightStatus ?? null;

  const header = <AppBar accent centerTitle showBack title="Night status" />;

  if (settings.loading) {
    return (
      <Screen header={header}>
        <SkeletonCard rows={3} />
      </Screen>
    );
  }

  if (settings.error || !nightStatus) {
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
      <NightStatusPromptCard onSaved={settings.refresh} settings={nightStatus} />
    </Screen>
  );
}
