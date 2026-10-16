import { router } from "expo-router";
import { View } from "react-native";

import { ProviderStatusCard } from "@/components/provider-status-card";
import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Card, SectionHeader } from "@/components/ui/card";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { SkeletonCard } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { humanizeEnum } from "@/lib/format";
import type { ProviderApplication } from "@/lib/provider-api";
import { providerQuery } from "@/lib/provider-queries";
import { providerStatusPanel } from "@/lib/provider-status";

/**
 * The provider's own record, and the door to their platform ID card.
 *
 * ## Two different cards, and only one of them lives here
 *
 * The *platform* ID card — the printable document with the QR, shared by
 * residents, owners and providers alike — is `app/id-card/`, and it already
 * renders the `SERVICE_PROVIDER` variant off `identity.cardType`. Rebuilding it
 * here would be a second renderer for the same document, which is how the two
 * drift apart. So this screen shows the *application*: what the platform holds
 * about this provider and whether it has been approved, with a row through to
 * the card itself.
 *
 * ## The status tag is the point of the screen
 *
 * `PENDING_APPROVAL` is not a soft state: an unapproved provider gets an empty
 * job list from the server, because `listOwnServiceProviderJobs` filters on an
 * APPROVED record. Without this tag, "no jobs yet" and "your application has
 * not been reviewed" look identical — the same empty-versus-denied confusion
 * the guardian screens are built to avoid.
 */
export default function ProviderCardScreen() {
  const dates = useDates();
  const query = providerQuery.application();
  const provider = useResource<ProviderApplication | null>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  const header = <AppBar title="My card" />;

  if (provider.loading) {
    return (
      <Screen header={header} insideTabs>
        <View className="gap-4 pt-1">
          <SkeletonCard rows={4} />
          <SkeletonCard rows={3} />
        </View>
      </Screen>
    );
  }

  if (provider.error) {
    return (
      <Screen header={header} insideTabs>
        <ErrorState message={provider.error} onRetry={provider.reload} />
      </Screen>
    );
  }

  const record = provider.data;

  if (!record) {
    return (
      <Screen header={header} insideTabs scroll>
        {/*
          Not an `<EmptyState>` telling somebody to go to a website. The app has
          taken its own applications since `service-providers/apply` shipped, and
          this card offers that form — see `provider-status-card.tsx`.

          Reaching this branch at all means the account was routed here as an
          approved provider and then answered `null`, which is a record deleted
          underneath a live session. Rare, and the honest recovery is the form.
        */}
        <ProviderStatusCard application={null} />
      </Screen>
    );
  }

  /*
   * The tone and the sentence both come from `lib/provider-status.ts`, so this
   * screen, the Profile tab's banner and the landing screen cannot describe the
   * same status three different ways.
   */
  const panel = providerStatusPanel(record);

  return (
    <Screen
      header={header}
      insideTabs
      onRefresh={provider.refresh}
      refreshing={provider.refreshing}
      scroll
    >
      <View className="gap-5 pt-1">
        <Card className="gap-3">
          <View className="flex-row items-start justify-between gap-3">
            <View className="flex-1 gap-1">
              <Text variant="subtitle">{record.fullName}</Text>
              <Text variant="caption">
                {[humanizeEnum(record.category), record.area, record.city]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
            </View>
            <Badge label={humanizeEnum(record.status)} tone={panel.tone} />
          </View>

          {/*
            The same sentence the Profile tab and the landing screen show for
            this status, from `lib/provider-status.ts` — including the rejection
            reason, which used to be a second block here and nowhere else.
          */}
          <Text className="leading-6" variant="muted">
            {panel.body}
          </Text>
        </Card>

        <View>
          <SectionHeader title="What the platform holds" />
          <Card>
            <ListRow title="Phone" value={record.phone} />
            <RowDivider />
            <ListRow title="Email" value={record.email || "—"} />
            <RowDivider />
            <ListRow
              title="Services"
              value={record.categories.map(humanizeEnum).join(", ") || "—"}
            />
            <RowDivider />
            <ListRow title="Availability" value={record.availability || "—"} />
            <RowDivider />
            <ListRow title="Experience" value={record.experience || "—"} />
            <RowDivider />
            <ListRow title="Documents on file" value={String(record.documentCount)} />
            {record.submittedAt ? (
              <>
                <RowDivider />
                <ListRow title="Applied" value={dates.date(record.submittedAt)} />
              </>
            ) : null}
          </Card>
          <Text className="px-1 pt-2" variant="caption">
            The application is a reviewed document, not a profile you edit in
            place — there is no edit route for it on any surface. Contact support
            if something here is wrong.
          </Text>
        </View>

        <Card>
          <ListRow
            icon="card"
            onPress={() => router.push("/id-card")}
            subtitle="The printable card with your QR, shared across the platform"
            title="Your ID card"
          />
        </Card>
      </View>
    </Screen>
  );
}
