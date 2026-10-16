import { Linking, View } from "react-native";

import { GuardianNotShared } from "@/components/guardian-not-shared";
import { NotificationBell } from "@/components/notification-bell";
import { AppBar } from "@/components/ui/app-bar";
import { StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Glyph } from "@/components/ui/glyph";
import { Chip, FactRow } from "@/components/ui/layout";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Skeleton, SkeletonCard } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { canSee } from "@/lib/guardian";
import type { GuardianDashboard } from "@/lib/guardian-api";
import { guardianQuery } from "@/lib/guardian-queries";

/**
 * Night status, the promise that comes with it, and how to reach the office.
 *
 * ## Two things this screen deliberately does not show
 *
 * **A time.** `safety.asOf` is a date because the serializer truncates it —
 * PHASES.md §4.1 treats the exact minute a resident was checked as
 * surveillance, not reassurance. The web page rendered `new Date(...)
 * .toLocaleString()` off a field that did not exist and printed "Invalid Date";
 * neither the bug nor the intent survives here.
 *
 * **An all-clear.** The web drew an "Emergency Status: Normal — no active
 * alerts" tile, and the guardian payload contains no SOS field of any kind, so
 * it printed "Normal" whether or not an alert was live. Telling a parent there
 * is no emergency without having asked is the one thing this screen must never
 * do, so the tile is gone rather than reworded.
 *
 * ## Notices moved to Home
 *
 * This screen used to end with a "Guardian-visible notices" section, under the
 * night status and the hostel's phone number. A notice is not a safety record —
 * it is the hostel talking to the household — and putting it here meant Home,
 * Safety and this tab all listed the same rows. Home keeps them now; this screen
 * is night status, the promise, the office, and what the ward has open with the
 * hostel, which is one subject.
 *
 * ## One contact card, not the web's two (§5.2)
 *
 * The web has a "Warden / Hostel In-charge" section and a "Hostel Emergency
 * Contact" section, and both render the **same** `hostel.contact.phone` — there
 * is no warden field in the guardian payload. Two cards offering one number
 * reads as two escalation routes and is one, so this screen keeps a single card
 * and adds the address and email the payload also carries.
 */
export default function GuardianSafetyScreen() {
  const { colors } = useAppTheme();
  // The portal's one key — see `lib/guardian-queries.ts`. This screen used to
  // name three topics of its own, which with a shared cache entry would have
  // made the payload's freshness depend on which tab happened to be mounted.
  const query = guardianQuery.dashboard();
  const guardian = useResource<GuardianDashboard>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  const header = <AppBar actions={<NotificationBell />} large title="Safety" />;

  if (guardian.loading) {
    return (
      <Screen header={header} insideTabs>
        {/* Status card, promise card, then the contact block. */}
        <View className="gap-5">
          <Skeleton height={130} radius={16} />
          <Skeleton height={96} radius={16} />
          <View className="gap-3">
            <Skeleton height={18} width="42%" />
            <SkeletonCard rows={3} />
          </View>
        </View>
      </Screen>
    );
  }

  if (guardian.error || !guardian.data) {
    return (
      <Screen header={header} insideTabs>
        <ErrorState
          message={guardian.error ?? "The safety summary could not be loaded."}
          onRetry={guardian.reload}
        />
      </Screen>
    );
  }

  const dashboard = guardian.data;
  const phone = dashboard.hostel?.contact.phone ?? "";
  const email = dashboard.hostel?.contact.email ?? "";
  const address = [
    dashboard.hostel?.location.address,
    dashboard.hostel?.location.area,
    dashboard.hostel?.location.city,
  ]
    .filter(Boolean)
    .join(", ");
  const safety = canSee(dashboard, "canViewSafety") ? dashboard.safety : null;

  return (
    <Screen
      header={header}
      insideTabs
      onRefresh={guardian.refresh}
      refreshing={guardian.refreshing}
      scroll
    >
      <View className="gap-5 pt-1">
        {safety ? (
          <Card className="gap-3">
            <View className="flex-row items-center justify-between gap-3">
              <Text variant="label">Current status</Text>
              <StatusPill status={safety.status} />
            </View>
            {/*
              `<FactRow>`, which is the kit's label/value pair (`NOTES.md` §8) —
              this card drew it by hand, without the wrap that component exists
              for. Day only. Never derive a time from this.
            */}
            <View className="border-t border-border pt-3">
              <FactRow label="Last update" value={safety.asOf ?? "Not verified"} />
            </View>
            <Text variant="caption">Marked by the hostel. Day only, never a time.</Text>
          </Card>
        ) : (
          /*
            The ward card that used to sit above this went to Home, where it is
            the hero. Repeating an identity block over a "not shared" notice
            makes the refusal read as one section of a working screen rather than
            as the whole answer.
          */
          <GuardianNotShared
            subject="night status"
            wardName={dashboard.resident.fullName}
          />
        )}

        {/*
          The privacy promise, kept from the web page word for word: it is the
          single most-read paragraph on a guardian screen and the reason the
          product can offer this tab at all.
        */}
        <Card className="gap-2">
          <View className="flex-row items-center gap-2">
            <Glyph color={colors.warning} name="lock-closed" size={18} />
            <Text variant="label">No GPS tracking. No location history.</Text>
          </View>
          <Text variant="muted">
            We do not track or share live location. Status is updated only by hostel
            staff, and shown to you as a day rather than a time.
          </Text>
        </Card>

        <View>
          <SectionHeader
            subtitle="For anything urgent, call the office"
            title="Hostel contact"
          />
          <Card className="gap-3">
            <View className="gap-1">
              <Text variant="label">{dashboard.hostel?.name ?? "Hostel office"}</Text>
              <Text variant="caption">{phone || "No number on file"}</Text>
            </View>

            {/*
              The address and the email, which the payload carries and this card
              did not show. A parent whose child is not answering wants to know
              where the building is, and that is exactly the moment they should
              not have to go looking for it.
            */}
            {address || email ? (
              <View className="flex-row flex-wrap gap-2">
                {address ? <Chip icon="location" label={address} /> : null}
                {email ? (
                  <Chip
                    icon="mail"
                    label={email}
                    onPress={() => void Linking.openURL(`mailto:${email}`)}
                  />
                ) : null}
              </View>
            ) : null}

            {phone ? (
              <View className="flex-row gap-2">
                <Button
                  className="flex-1"
                  label="Call"
                  onPress={() => void Linking.openURL(`tel:${phone}`)}
                />
                <Button
                  className="flex-1"
                  label="Message"
                  onPress={() => void Linking.openURL(`sms:${phone}`)}
                  variant="outline"
                />
              </View>
            ) : null}
          </Card>
        </View>

        {canSee(dashboard, "canViewComplaintStatus") ? (
          <View>
            <SectionHeader
              subtitle="Status only — never what they wrote"
              title="Open with the hostel"
            />
            <Card padding="px-4 py-1">
              {dashboard.complaints.length === 0 ? (
                <View className="py-3">
                  <Text variant="muted">
                    {`${dashboard.resident.fullName} has not raised anything with the hostel.`}
                  </Text>
                </View>
              ) : (
                dashboard.complaints.map((complaint, index) => (
                  <View key={complaint.id}>
                    {index > 0 ? <RowDivider /> : null}
                    <ListRow
                      right={<StatusPill status={complaint.status} />}
                      title={complaint.title}
                    />
                  </View>
                ))
              )}
            </Card>
          </View>
        ) : null}
      </View>
    </Screen>
  );
}
