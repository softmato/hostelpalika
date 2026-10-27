import { roomTypeLabel } from "@hostel/constants/room-types";
import { router } from "expo-router";
import { Linking, Pressable, View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Badge, StatusPill } from "@/components/ui/badge";
import { Card, SectionHeader } from "@/components/ui/card";
import { Glyph } from "@/components/ui/glyph";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { SkeletonCard, SkeletonRows } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { formatMoney, humanizeEnum } from "@/lib/format";
import type { ResidentProfile } from "@/lib/resident-api";
import { residentQuery } from "@/lib/resident-queries";

/**
 * Who the hostel thinks you are.
 *
 * ## Read-only, and it says so where it matters
 *
 * `GET /resident/profile` is the only route here. There is no resident-facing
 * write for any of it: not the personal details (`resident.service.ts`'s update is
 * staff-only), not the guardians (`/resident/guardians` is GET plus an *invite*,
 * which is its own flow), and not the emergency contacts — `/resident/emergency-contacts`
 * is GET-only and the sole `EmergencyContactModel.create` in the repo sits inside
 * admin resident creation. §1 of `docs/MOBILE_APP_PHASES.md` tracks both gaps.
 *
 * So no Edit button is drawn anywhere. Each section that a resident would
 * reasonably expect to edit says who can change it instead — the rule `app/sos.tsx`
 * set for the same contacts: an honest instruction beats a control the server
 * would ignore, because a silent control makes the user believe it worked.
 *
 * ## Phone numbers are tappable
 *
 * Same reasoning as the SOS screen. A number a resident has to memorise and
 * retype is a number nobody calls.
 */

export default function ProfileScreen() {
  const dates = useDates();
  /*
   * Read-only to the resident, and therefore only ever changed by somebody
   * else — the office correcting a phone number, a bed move, a guardian
   * invitation accepted. Which is exactly the case a live screen is for: the
   * resident has no action of their own to trigger a refetch with.
   */
  const query = residentQuery.profile();
  const profile = useResource<ResidentProfile>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  const header = <AppBar showBack title="Profile" />;

  if (profile.loading) {
    return (
      <Screen header={header}>
        <View className="gap-4 pt-1">
          <SkeletonCard rows={3} />
          <SkeletonRows rows={3} />
        </View>
      </Screen>
    );
  }

  if (profile.error || !profile.data) {
    return (
      <Screen header={header}>
        <ErrorState
          message={profile.error ?? "Your profile could not be loaded."}
          onRetry={profile.reload}
        />
      </Screen>
    );
  }

  const { accommodation, emergencyContacts, guardians, hostel, resident } =
    profile.data;

  return (
    <Screen
      header={header}
      onRefresh={profile.refresh}
      refreshing={profile.refreshing}
      scroll
    >
      <View className="gap-5 pt-1">
        <IdentityCard resident={resident} />

        <View>
          <SectionHeader
            subtitle="Your hostel's office keeps these up to date"
            title="Details"
          />
          <Card>
            <ListRow title="Full name" value={resident.fullName} />
            <RowDivider />
            <CallableRow label="Phone" value={resident.phone} />
            <RowDivider />
            <ListRow title="Email" value={resident.email || "—"} />
            <RowDivider />
            <ListRow title="Resident type" value={humanizeEnum(resident.residentType)} />
          </Card>
        </View>

        <View>
          <SectionHeader title="Your stay" />
          <Card>
            <ListRow title="Room type" value={roomTypeLabel(accommodation.roomType)} />
            <RowDivider />
            <ListRow title="Moved in" value={dates.date(resident.moveInDate)} />
            <RowDivider />
            {/*
              The deposit is shown because a resident cannot otherwise find out
              what the hostel is holding — the finance screens are about invoices
              and the deposit is not one. `depositAmount` is on the resident row.
            */}
            <ListRow title="Deposit held" value={formatMoney(resident.depositAmount)} />
          </Card>
        </View>

        {hostel ? (
          <View>
            <SectionHeader title="Your hostel" />
            <Card>
              <ListRow
                onPress={() => router.push(`/hostel/${hostel.slug}`)}
                subtitle={
                  [hostel.location.area, hostel.location.city]
                    .filter(Boolean)
                    .join(", ") || undefined
                }
                title={hostel.name}
              />
              {hostel.contact.phone ? (
                <>
                  <RowDivider />
                  <CallableRow label="Office" value={hostel.contact.phone} />
                </>
              ) : null}
              {hostel.contact.email ? (
                <>
                  <RowDivider />
                  <ListRow title="Office email" value={hostel.contact.email} />
                </>
              ) : null}
            </Card>
          </View>
        ) : null}

        <PeopleSection
          /*
           * No longer a dead end, and the copy that made it one is gone.
           *
           * This section used to say guardians "are invited by your hostel and
           * manage their own accounts", which was wrong on the first half:
           * `inviteGuardian`'s own comment says the **resident** owns the link
           * and the permissions on it, and `POST`/`PATCH`/`DELETE
           * /resident/guardians` were live the whole time with nothing on the
           * phone calling them. The rule the rest of this screen follows — say
           * who can change a thing rather than draw a control the server
           * ignores — was being applied to the one section where the server did
           * not ignore it.
           *
           * The rows stay read-only *here* because this screen is the record;
           * the door into managing them is below.
           */
          action={{ href: "/guardians", label: "Manage" }}
          emptyBody="Invite a parent or guardian and they get their own sign-in, showing only what you choose to share."
          emptyTitle="No guardians linked"
          footnote="You decide who is linked, and what each of them can see."
          people={guardians.map((guardian) => ({
            id: guardian.id,
            isPrimary: guardian.isPrimary,
            name: `${guardian.firstName} ${guardian.lastName}`.trim(),
            phone: guardian.phone,
            relation: guardian.relation,
            subtitle: guardian.email || undefined,
          }))}
          title="Guardians"
        />

        <PeopleSection
          /* Same wording as `app/sos.tsx` — one gap, one explanation. */
          emptyBody="Your hostel records these when you move in. Ask the office to add someone — they can't be added from the app yet."
          emptyTitle="No contacts on file"
          footnote="These are who your hostel rings in an emergency. Only the office can change them."
          people={emergencyContacts.map((contact) => ({
            id: contact.id,
            isPrimary: contact.isPrimary,
            name: contact.name,
            phone: contact.phone,
            relation: contact.relation,
          }))}
          title="Emergency contacts"
        />
      </View>
    </Screen>
  );
}

function IdentityCard({ resident }: { resident: ResidentProfile["resident"] }) {
  const { colors } = useAppTheme();

  return (
    <Card className="flex-row items-center gap-3">
      <View
        className="h-16 w-16 items-center justify-center rounded-full"
        style={{ backgroundColor: colors.brandSoft }}
      >
        <Text className="text-2xl font-semibold" style={{ color: colors.primary }}>
          {resident.firstName.charAt(0).toUpperCase()}
        </Text>
      </View>

      <View className="flex-1 gap-1">
        <Text variant="subtitle">{resident.fullName}</Text>
        <Text variant="caption">{resident.email || resident.phone}</Text>
      </View>

      <StatusPill status={resident.status} />
    </Card>
  );
}

/** A row whose value dials it. */
function CallableRow({ label, value }: { label: string; value: string }) {
  const { colors } = useAppTheme();

  if (!value) {
    return <ListRow title={label} value="—" />;
  }

  return (
    <ListRow
      onPress={() => void Linking.openURL(`tel:${value}`)}
      right={
        <View className="flex-row items-center gap-1.5">
          <Text variant="muted">{value}</Text>
          <Glyph color={colors.primary} name="call" size={16} />
        </View>
      }
      title={label}
    />
  );
}

type Person = {
  id: string;
  isPrimary: boolean;
  name: string;
  phone: string;
  relation: string;
  subtitle?: string;
};

/**
 * Guardians and emergency contacts are the same shape on screen and the same
 * story underneath — a list the resident cannot edit — so they share a component
 * rather than two that drift.
 */
function PeopleSection({
  action,
  emptyBody,
  emptyTitle,
  footnote,
  people,
  title,
}: {
  /**
   * A destination for the section, in the header.
   *
   * Only guardians have one, and that asymmetry is the point: emergency
   * contacts genuinely have no resident-facing write (`/resident/emergency-
   * contacts` is GET-only), so that section stays a statement of who to ask.
   * Giving both a Manage row would put a door on a wall.
   */
  action?: { href: string; label: string };
  emptyBody: string;
  emptyTitle: string;
  footnote: string;
  people: Person[];
  title: string;
}) {
  const { colors } = useAppTheme();

  return (
    <View>
      <SectionHeader
        action={
          action ? (
            <Pressable
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => router.push(action.href)}
            >
              <Text className="text-primary" variant="label">
                {action.label}
              </Text>
            </Pressable>
          ) : undefined
        }
        subtitle={footnote}
        title={title}
      />

      <Card>
        {people.length === 0 ? (
          /*
            No Add button in the card, for two different reasons depending on
            which section this is. Emergency contacts have no endpoint to add
            one, so the honest instruction is who to ask. Guardians do — and
            their door is the `action` in the header above, where it is in reach
            whether or not the list is empty, rather than a button that appears
            only when there is nothing to see.
          */
          <View className="gap-1 py-2">
            <Text variant="label">{emptyTitle}</Text>
            <Text variant="caption">{emptyBody}</Text>
          </View>
        ) : (
          people.map((person, index) => (
            <View key={person.id}>
              {index > 0 ? <RowDivider /> : null}

              <Pressable
                accessibilityHint={person.phone ? `Calls ${person.phone}` : undefined}
                accessibilityLabel={
                  person.phone ? `Call ${person.name}` : person.name
                }
                accessibilityRole="button"
                className="min-h-14 flex-row items-center gap-3 py-3 active:opacity-70"
                disabled={!person.phone}
                onPress={() => void Linking.openURL(`tel:${person.phone}`)}
              >
                <View
                  className="h-10 w-10 items-center justify-center rounded-full"
                  style={{ backgroundColor: colors.muted }}
                >
                  <Glyph
                    color={colors.mutedForeground}
                    name="person"
                    size={18}
                  />
                </View>

                <View className="flex-1">
                  <View className="flex-row items-center gap-2">
                    <Text variant="label">{person.name}</Text>
                    {person.isPrimary ? <Badge label="Primary" /> : null}
                  </View>
                  <Text variant="caption">
                    {[humanizeEnum(person.relation), person.subtitle]
                      .filter(Boolean)
                      .join(" · ")}
                  </Text>
                </View>

                {person.phone ? (
                  <View className="flex-row items-center gap-1.5">
                    <Text variant="muted">{person.phone}</Text>
                    <Glyph color={colors.primary} name="call" size={16} />
                  </View>
                ) : null}
              </Pressable>
            </View>
          ))
        )}
      </Card>
    </View>
  );
}
