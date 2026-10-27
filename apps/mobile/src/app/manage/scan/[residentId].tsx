import { roomTypeLabel } from "@hostel/constants/room-types";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { router, useLocalSearchParams } from "expo-router";
import { Linking, View } from "react-native";

import { FLOAT_SHADOW, usePortalPaint } from "@/components/portal-shared";
import { ActionCard, ActionCell } from "@/components/ui/action-grid";
import { AppBar } from "@/components/ui/app-bar";
import { Badge, StatusPill } from "@/components/ui/badge";
import { Card, SectionHeader } from "@/components/ui/card";
import { Glyph, type GlyphName } from "@/components/ui/glyph";
import { Chip, FactRow, StatTile } from "@/components/ui/layout";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Money } from "@/components/ui/money";
import { Screen } from "@/components/ui/screen";
import { SkeletonCard } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { adminQuery } from "@/lib/admin-queries";
import {
  type ResidentScan,
  type ScannedMembership,
  type ScannedProfile,
  scannedPhotoSource,
} from "@/lib/admin-scan-api";
import {
  formatMoney,
  humanizeEnum,
} from "@/lib/format";
import { paymentStanding } from "@/lib/resident-scan";
import { APP_NAME } from "@/constants/branding";

/**
 * Who this card belongs to, and everything the hostel knows about them.
 *
 * ## The screen the scan exists for
 *
 * A hostel owner holding somebody's ID card in a corridor is asking one
 * question with several parts: is this person ours, which room, are they paid
 * up, who do I call if something happens to them, and is there anything about
 * them I should know before I let them past. This screen answers all of it in
 * one scroll and does not send anyone to the browser for the rest — see the
 * "no browser hand-offs" rule.
 *
 * ## Two owners, two halves, and the screen says which is which
 *
 * `profile` is the holder's **own** portable profile — their blood group, their
 * guardians, their government ID — disclosed under a sharing switch they
 * control, and they get a notification every time it is read.
 *
 * `membership` is the hostel's **own** tenancy record — the row it typed in,
 * the money it billed, the complaints it was sent. It is not gated on that
 * switch, because a toggle on somebody's platform profile cannot take a
 * hostel's roster away from it.
 *
 * Either can be absent, and when one is, the server sends the reason as a
 * sentence rather than an empty object. This screen prints that sentence where
 * the data would have been. That is why there is no error state for a card that
 * scanned fine but has little behind it.
 *
 * ## The money can be refused on its own
 *
 * `viewPayments` is a separate warden grant, so `ledger: null` with
 * `ledgerDenied: true` is a normal answer. A missing ledger and a resident who
 * owes nothing must never look the same — one is "we were not allowed to look",
 * the other is "they are straight with you" — so the section prints which.
 *
 * ## Layout
 *
 * Painted identity block with a rounded bottom and the actions straddling its
 * edge (NOTES.md §1, §2), then label/value grids in cards (§8). Nothing here is
 * a summary of a screen one tap away; this *is* the detail view.
 */
export default function ScannedResidentScreen() {
  const dates = useDates();
  const { residentId } = useLocalSearchParams<{ residentId: string }>();
  const token = useAppSelector((state) => state.auth.accessToken);

  /*
   * `refetchOnFocus` is off, and that is a privacy decision rather than a
   * performance one. Every successful read of somebody's profile is audited and
   * **announced to them** — so with the default on, a warden who opened a
   * complaint from this page and pressed back would send that resident a second
   * "your ID card was scanned" notification for a single scan. Pull-to-refresh
   * stays, because that is somebody deliberately asking again, and the server
   * holds a quiet window over the notification for exactly that case.
   */
  const query = adminQuery.residentScan(residentId);
  const scan = useResource<ResidentScan>(query.load, {
    cacheKey: query.key,
    refetchOnFocus: false,
    topics: query.topics,
  });

  const header = <AppBar accent centerTitle showBack title="Resident card" />;

  if (scan.loading) {
    return (
      <Screen header={header}>
        <View className="gap-4 pt-1">
          <SkeletonCard rows={3} />
          <SkeletonCard rows={3} />
        </View>
      </Screen>
    );
  }

  if (scan.error || !scan.data) {
    return (
      <Screen header={header}>
        <ErrorState
          message={scan.error ?? "That card could not be read."}
          onRetry={scan.reload}
        />
      </Screen>
    );
  }

  const data = scan.data;
  const { membership, profile } = data;
  const photo = scannedPhotoSource(data, token);

  const name = profile?.fullName ?? data.account.name;
  const phone = membership?.resident.phone ?? profile?.primaryPhone ?? null;

  return (
    <Screen
      header={header}
      onRefresh={scan.refresh}
      padded={false}
      refreshing={scan.refreshing}
      scroll
    >
      <IdentityBlock
        cardRole={data.account.cardRole}
        name={name}
        photo={photo}
        residentId={data.residentId}
        status={membership?.resident.status ?? null}
        subtitle={
          membership
            ? `${roomTypeLabel(membership.resident.roomType)} · ${membership.hostel.name}`
            : (profile?.occupation ? humanizeEnum(profile.occupation) : data.account.email) ??
              "Not on your roll"
        }
      />

      <View className="gap-6 px-5 pt-4">
        <ActionRow
          membership={membership}
          onOpenRecord={
            membership
              ? () => router.push(`/manage/resident/${membership.resident.id}`)
              : undefined
          }
          onRegister={() => router.push("/manage/resident/new")}
          phone={phone}
        />

        {/*
          The three things that would make a reader mistrust the rest of the
          page if they were not said first: this is the wrong kind of card, this
          person is not yours, or the row we matched is a guess.
        */}
        {data.account.cardType === "RESIDENT" ? null : (
          <Notice
            icon="alert-circle"
            text={
              data.account.cardType === "SERVICE_PROVIDER"
                ? `This is a service provider's card${data.account.cardRole ? ` (${data.account.cardRole})` : ""}, not a resident's. They cannot be registered as a resident with it.`
                : "This is a hostel owner's card, not a resident's. They cannot be registered as a resident with it."
            }
            tone="warning"
          />
        )}

        {membership?.matchedBy && membership.matchedBy !== "ACCOUNT" ? (
          <Notice
            icon="link"
            text={`Matched to this record by ${membership.matchedBy === "PHONE" ? "phone number" : "email"} — they have never signed in to the app, so the link is not confirmed.`}
            tone="muted"
          />
        ) : null}

        {membership ? null : (
          <Notice
            icon="person-add"
            text={data.membershipNotice ?? "They are not on your roll."}
            tone="muted"
          />
        )}

        <PaymentsSection membership={membership} />

        {membership ? <TenancySection membership={membership} /> : null}

        <PersonSection
          email={data.account.email}
          notice={data.profileNotice}
          profile={profile}
        />

        <ContactsSection membership={membership} profile={profile} />

        {membership ? <ComplaintsSection membership={membership} /> : null}

        <Text className="pb-2 text-center text-xs text-muted-foreground">
          {`Card read ${dates.dateTime(data.scannedAt)}. ${
            profile
              ? "They were told their profile was opened."
              : "Nothing of theirs was disclosed."
          }`}
        </Text>
      </View>
    </Screen>
  );
}

/* -------------------------------------------------------------------------- */
/* Identity                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The painted block that says who this is.
 *
 * Same object as admin Home's hero, at the size a pushed screen wants: a
 * saturated card carrying the identity, a state pill, and the number underneath
 * it. Its foreground literals are literals for the reason `admin-home.tsx`
 * documents — a themed `foreground` on the paint is near-black in light mode.
 *
 * The photograph is the point of it. A hostel owner comparing a face on a phone
 * to the face in front of them is doing the only check this whole feature can
 * make against a borrowed card, so it is drawn as large as the block allows and
 * falls back to an initial rather than to a grey silhouette.
 */
function IdentityBlock({
  cardRole,
  name,
  photo,
  residentId,
  status,
  subtitle,
}: {
  cardRole: string | null;
  name: string;
  photo: { headers?: Record<string, string>; uri: string } | null;
  residentId: string;
  status: string | null;
  subtitle: string;
}) {
  const paint = usePortalPaint();

  return (
    <LinearGradient
      colors={[paint.from, paint.from, paint.to]}
      end={{ x: 0, y: 1 }}
      locations={[0, 0.45, 1]}
      start={{ x: 0, y: 0 }}
      style={[
        FLOAT_SHADOW,
        { borderBottomLeftRadius: 28, borderBottomRightRadius: 28, overflow: "hidden" },
      ]}
    >
      <View className="flex-row items-center gap-4 px-5 pb-6 pt-5">
        <View className="h-20 w-20 items-center justify-center overflow-hidden rounded-2xl border border-white/30 bg-white/15">
          {photo ? (
            <Image
              cachePolicy="memory-disk"
              contentFit="cover"
              source={photo}
              style={{ height: 80, width: 80 }}
              transition={200}
            />
          ) : (
            <Text className="text-3xl font-bold text-white">
              {name.trim().charAt(0).toUpperCase() || "?"}
            </Text>
          )}
        </View>

        <View className="flex-1 gap-1.5">
          <Text
            className="font-semibold text-white"
            numberOfLines={2}
            style={{ fontSize: 20, lineHeight: 25 }}
          >
            {name}
          </Text>

          <Text className="text-xs text-white/75" numberOfLines={1}>
            {subtitle}
          </Text>

          <View className="flex-row flex-wrap items-center gap-2 pt-0.5">
            <View className="flex-row items-center gap-1.5 rounded-full bg-black/25 px-2.5 py-1">
              <Glyph color="rgba(255,255,255,0.8)" name="id-card" size={12} />
              <Text className="text-[11px] font-semibold tracking-wide text-white">
                {residentId}
              </Text>
            </View>

            {status ? <StatusPill status={status} /> : null}
            {cardRole ? <Badge label={cardRole} tone="info" /> : null}
          </View>
        </View>
      </View>
    </LinearGradient>
  );
}

/**
 * The row that straddles the painted edge — the three things you do *with* a
 * person rather than read about them.
 *
 * `Register them` only when there is nothing to open, and `Open record` only
 * when there is: one cell, two states, because a corridor is no place to choose
 * between two similar buttons.
 */
function ActionRow({
  membership,
  onOpenRecord,
  onRegister,
  phone,
}: {
  membership: ScannedMembership | null;
  onOpenRecord?: () => void;
  onRegister: () => void;
  phone: string | null;
}) {
  const { colors } = useAppTheme();

  // The shared four-up card (`action-grid.tsx`), not three bordered tiles: one
  // shape for every row of doors in the app, still straddling the header.
  return (
    <View className="-mt-9">
      <ActionCard>
        <ActionCell
          disabled={!phone}
          glyph={colors.primary}
          icon="call"
          label="Call"
          onPress={() => phone && void Linking.openURL(`tel:${phone}`)}
          tone="brand"
        />
        <ActionCell
          disabled={!phone}
          glyph={colors.primary}
          icon="chatbubble"
          label="Message"
          onPress={() => phone && void Linking.openURL(`sms:${phone}`)}
          tone="brand"
        />
        {membership && onOpenRecord ? (
          <ActionCell glyph={colors.primary} icon="folder-open" label="Full record" onPress={onOpenRecord} tone="brand" />
        ) : (
          <ActionCell glyph={colors.primary} icon="person-add" label="Register" onPress={onRegister} tone="brand" />
        )}
      </ActionCard>
    </View>
  );
}

/**
 * A sentence where a section would have been.
 *
 * The alternative — hiding the section — is what makes somebody scroll the page
 * twice looking for the money. A stated reason is shorter than the thing it
 * replaces and ends the search.
 */
function Notice({
  icon,
  text,
  tone,
}: {
  icon: GlyphName;
  text: string;
  tone: "muted" | "warning";
}) {
  const { colors } = useAppTheme();
  const warning = tone === "warning";

  return (
    <View
      className={`flex-row items-start gap-3 rounded-2xl border px-4 py-3 ${
        warning ? "border-warning/30 bg-warning-soft" : "border-border bg-muted"
      }`}
    >
      <Glyph
        color={warning ? colors.warning : colors.mutedForeground}
        name={icon}
        size={17}
        style={{ marginTop: 1 }}
      />
      <Text className={`flex-1 text-sm ${warning ? "text-warning" : "text-muted-foreground"}`}>
        {text}
      </Text>
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Sections                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What they have paid and what they still owe.
 *
 * Three states, and they are three different sentences: not on the roll (there
 * is no money to talk about), refused (a warden without `viewPayments`), and
 * the ledger itself. Collapsing the middle one into "nothing owed" is the
 * mistake that makes a screen lie about a debt.
 */
function PaymentsSection({ membership }: { membership: ScannedMembership | null }) {
  const dates = useDates();

  if (!membership) {
    return null;
  }

  const standing = paymentStanding(membership.ledger);

  return (
    <View>
      <SectionHeader title="Money" />

      {standing ? (
        <View className="gap-3">
          <View className="flex-row gap-3">
            <StatTile
              icon="wallet"
              label="Still owed"
              tone={standing.outstanding > 0 ? "danger" : "success"}
              trend={
                standing.unpaid.length
                  ? `${standing.unpaid.length} month${standing.unpaid.length === 1 ? "" : "s"} behind`
                  : "Nothing outstanding"
              }
              value={formatMoney(standing.outstanding)}
            />
            <StatTile
              icon="checkmark-done"
              label="Paid so far"
              tone="brand"
              trend={`${standing.monthsPaid} of ${standing.monthsBilled} months`}
              value={formatMoney(standing.paid)}
            />
          </View>

          <Card className="gap-1">
            <FactRow
              label="Paid up to"
              value={
                standing.paidThrough ? (
                  dates.period(standing.paidThrough)
                ) : (
                  <Text variant="muted">Nothing settled yet</Text>
                )
              }
            />
            <FactRow
              label="Behind on"
              value={
                standing.unpaid.length ? (
                  standing.unpaid.map((month) => dates.period(month.period)).join(", ")
                ) : (
                  <Text variant="muted">Nothing</Text>
                )
              }
            />
          </Card>

          {standing.recent.length ? (
            <Card padding="px-4 py-1">
              {standing.recent.map((month, index) => (
                <View key={month.period}>
                  {index === 0 ? null : <RowDivider />}
                  <ListRow
                    right={
                      <View className="items-end gap-1">
                        <Money
                          owed
                          value={Math.max(month.dueAmount - month.paidAmount, 0)}
                        />
                        <StatusPill status={month.status} />
                      </View>
                    }
                    subtitle={`Billed ${formatMoney(month.dueAmount)} · paid ${formatMoney(month.paidAmount)}`}
                    title={dates.period(month.period)}
                  />
                </View>
              ))}
            </Card>
          ) : (
            <Card>
              <Text variant="muted">
                Nothing has been billed to them yet.
              </Text>
            </Card>
          )}
        </View>
      ) : (
        <Notice
          icon="lock-closed"
          text={
            membership.ledgerDenied
              ? "Your account cannot see payments. Ask the owner for the “view payments” permission and this fills in."
              : "Their payment history could not be loaded just now. Pull down to try again."
          }
          tone="muted"
        />
      )}
    </View>
  );
}

/** The hostel's own tenancy record — the row it typed in itself. */
function TenancySection({ membership }: { membership: ScannedMembership }) {
  const dates = useDates();
  const { resident } = membership;

  return (
    <View>
      <SectionHeader subtitle={membership.hostel.name} title="Their stay" />

      <Card className="gap-1">
        <FactRow label="Room type" value={roomTypeLabel(resident.roomType)} />
        <FactRow label="Status" value={<StatusPill status={resident.status} />} />
        <FactRow label="They are a" value={humanizeEnum(resident.residentType)} />
        <FactRow label="Moved in" value={dates.date(resident.moveInDate)} />
        <FactRow
          label="Monthly fee"
          value={
            resident.monthlyFee === null ? (
              <Text variant="muted">On the fee schedule</Text>
            ) : resident.monthlyFee === 0 ? (
              <Text variant="muted">Free stay</Text>
            ) : (
              <Money value={resident.monthlyFee} />
            )
          }
        />
        <FactRow label="Deposit held" value={<Money value={resident.depositAmount} />} />
        <FactRow label="Registered" value={dates.date(resident.createdAt)} />
        <FactRow
          label="App account"
          value={
            resident.userId ? (
              "Signed in"
            ) : (
              <Text variant="muted">Never activated</Text>
            )
          }
        />
      </Card>

      {membership.nightStatus ? (
        <View className="pt-3">
          <Card className="flex-row items-center gap-3">
            <NightGlyph />
            <View className="flex-1">
              <Text variant="label">
                {humanizeEnum(membership.nightStatus.status)}
              </Text>
              <Text variant="caption">
                {`Last checked ${dates.dateTime(membership.nightStatus.checkedAt)}${
                  membership.nightStatus.source === "RESIDENT"
                    ? ""
                    : ` · ${humanizeEnum(membership.nightStatus.source)}`
                }`}
              </Text>
              {membership.nightStatus.note ? (
                <Text variant="caption">{membership.nightStatus.note}</Text>
              ) : null}
            </View>
          </Card>
        </View>
      ) : null}
    </View>
  );
}

/**
 * Everything the person themselves put on the card.
 *
 * Blood group and medical notes lead the safety block deliberately: they are the
 * two facts on this screen that somebody might need in the thirty seconds after
 * a fall on a staircase, and they are the reason the profile is worth
 * collecting at all.
 */
function PersonSection({
  email,
  notice,
  profile,
}: {
  email: string | null;
  notice: string | null;
  profile: ScannedProfile | null;
}) {
  const dates = useDates();

  if (!profile) {
    return (
      <View>
        <SectionHeader title="About them" />
        <Notice
          icon="person"
          text={notice ?? "Their profile is not available."}
          tone="muted"
        />
      </View>
    );
  }

  return (
    <View className="gap-3">
      <View>
        <SectionHeader subtitle={`From their own ${APP_NAME} profile`} title="About them" />
        <Card className="gap-1">
          <FactRow label="Full name" value={profile.fullName} />
          <FactRow
            label="Date of birth"
            value={
              profile.dateOfBirth
                ? `${dates.date(profile.dateOfBirth)}${profile.age === null ? "" : ` · ${profile.age}`}`
                : "—"
            }
          />
          <FactRow label="Gender" value={humanizeEnum(profile.gender)} />
          <FactRow label="Occupation" value={humanizeEnum(profile.occupation)} />
          {profile.institution ? (
            <FactRow label="Institution" value={profile.institution} />
          ) : null}
          {profile.courseOrDesignation ? (
            <FactRow label="Course / role" value={profile.courseOrDesignation} />
          ) : null}
          {profile.budgetRange ? (
            <FactRow label="Budget" value={profile.budgetRange} />
          ) : null}
        </Card>
      </View>

      <View>
        <SectionHeader title="Safety" />
        <Card className="gap-1">
          <FactRow label="Blood group" value={humanizeEnum(profile.bloodGroup)} />
          <FactRow label="Diet" value={humanizeEnum(profile.dietaryPreference)} />
          <FactRow
            label="Medical notes"
            value={
              profile.medicalNotes ?? <Text variant="muted">None recorded</Text>
            }
          />
          <FactRow
            label="Government ID"
            value={
              profile.governmentIdNumber ? (
                `${humanizeEnum(profile.governmentIdType)} · ${profile.governmentIdNumber}`
              ) : (
                <Text variant="muted">Not on file</Text>
              )
            }
          />
        </Card>
      </View>

      <View>
        <SectionHeader title="Where they are from" />
        <Card className="gap-1">
          <FactRow
            label="Address"
            value={
              profile.permanentAddress ?? <Text variant="muted">Not given</Text>
            }
          />
          <FactRow label="City" value={profile.city ?? "—"} />
          <FactRow label="Province" value={profile.province ?? "—"} />
        </Card>
      </View>

      {profile.interests.length ? (
        <View>
          <SectionHeader title="Interests" />
          <Card>
            <View className="flex-row flex-wrap gap-2">
              {profile.interests.map((interest) => (
                <Chip key={interest} label={interest} />
              ))}
            </View>
          </Card>
        </View>
      ) : null}

      {email && email !== profile.primaryEmail ? (
        <Card className="gap-1">
          <FactRow label="Account email" value={email} />
        </Card>
      ) : null}
    </View>
  );
}

/**
 * Who to ring, in the order you would ring them.
 *
 * The hostel's own guardian rows come first when there are any — they are what
 * this hostel agreed with this family — and the profile's guardians fill in
 * behind them for somebody who has never been through a move-in. Both are
 * one-tap dials, because a number you have to memorise off a screen is a number
 * nobody uses.
 */
function ContactsSection({
  membership,
  profile,
}: {
  membership: ScannedMembership | null;
  profile: ScannedProfile | null;
}) {
  const hostelGuardians = membership?.contacts.guardians ?? [];
  const hostelEmergency = membership?.contacts.emergencyContacts ?? [];

  const profileGuardians = profile
    ? [
        {
          email: profile.guardianEmail ?? "",
          name: profile.guardianName,
          phone: profile.guardianPhone,
          relation: profile.guardianRelation,
        },
        ...(profile.secondGuardianName && profile.secondGuardianPhone
          ? [
              {
                email: profile.secondGuardianEmail ?? "",
                name: profile.secondGuardianName,
                phone: profile.secondGuardianPhone,
                relation: profile.secondGuardianRelation ?? "Guardian",
              },
            ]
          : []),
      ]
    : [];

  const emergency =
    profile?.emergencyContactName && profile.emergencyContactPhone
      ? {
          name: profile.emergencyContactName,
          phone: profile.emergencyContactPhone,
          relation: profile.emergencyContactRelation ?? "Emergency contact",
        }
      : null;

  const own: { label: string; value: string }[] = [];

  if (profile?.primaryPhone) {
    own.push({ label: "Phone", value: profile.primaryPhone });
  }

  if (profile?.alternatePhone) {
    own.push({ label: "Other phone", value: profile.alternatePhone });
  }

  if (profile?.primaryEmail) {
    own.push({ label: "Email", value: profile.primaryEmail });
  }

  if (profile?.backupEmail) {
    own.push({ label: "Backup email", value: profile.backupEmail });
  }

  const nothing =
    own.length === 0 &&
    hostelGuardians.length === 0 &&
    hostelEmergency.length === 0 &&
    profileGuardians.length === 0 &&
    !emergency;

  if (nothing) {
    return null;
  }

  return (
    <View className="gap-3">
      {own.length ? (
        <View>
          <SectionHeader title="Reaching them" />
          <Card padding="px-4 py-1">
            {own.map((row, index) => (
              <View key={row.label}>
                {index === 0 ? null : <RowDivider inset />}
                <ListRow
                  icon={row.label.includes("mail") ? "mail" : "call"}
                  onPress={() =>
                    void Linking.openURL(
                      row.label.includes("mail")
                        ? `mailto:${row.value}`
                        : `tel:${row.value}`,
                    )
                  }
                  subtitle={row.label}
                  title={row.value}
                />
              </View>
            ))}
          </Card>
        </View>
      ) : null}

      <View>
        <SectionHeader
          subtitle={hostelGuardians.length ? "On your record" : "From their profile"}
          title="Guardians"
        />
        <Card padding="px-4 py-1">
          {hostelGuardians.length ? (
            hostelGuardians.map((guardian, index) => (
              <View key={guardian.id}>
                {index === 0 ? null : <RowDivider inset />}
                <PersonRow
                  isPrimary={guardian.isPrimary}
                  name={`${guardian.firstName} ${guardian.lastName}`.trim()}
                  phone={guardian.phone}
                  relation={guardian.relation}
                />
              </View>
            ))
          ) : profileGuardians.length ? (
            profileGuardians.map((guardian, index) => (
              <View key={`${guardian.name}-${guardian.phone}`}>
                {index === 0 ? null : <RowDivider inset />}
                <PersonRow
                  isPrimary={index === 0}
                  name={guardian.name}
                  phone={guardian.phone}
                  relation={guardian.relation}
                />
              </View>
            ))
          ) : (
            <View className="py-3">
              <Text variant="muted">No guardian on file.</Text>
            </View>
          )}
        </Card>
      </View>

      {hostelEmergency.length || emergency ? (
        <View>
          <SectionHeader title="In an emergency" />
          <Card padding="px-4 py-1">
            {hostelEmergency.length ? (
              hostelEmergency.map((contact, index) => (
                <View key={contact.id}>
                  {index === 0 ? null : <RowDivider inset />}
                  <PersonRow
                    isPrimary={contact.isPrimary}
                    name={contact.name}
                    phone={contact.phone}
                    relation={contact.relation}
                  />
                </View>
              ))
            ) : emergency ? (
              <PersonRow
                isPrimary
                name={emergency.name}
                phone={emergency.phone}
                relation={emergency.relation}
              />
            ) : null}
          </Card>
        </View>
      ) : null}
    </View>
  );
}

function PersonRow({
  isPrimary,
  name,
  phone,
  relation,
}: {
  isPrimary: boolean;
  name: string;
  phone: string;
  relation: string;
}) {
  return (
    <ListRow
      icon="call"
      onPress={() => void Linking.openURL(`tel:${phone}`)}
      right={
        <View className="items-end gap-1">
          <Text variant="label">{phone}</Text>
          {isPrimary ? <Badge label="Primary" tone="success" /> : null}
        </View>
      }
      subtitle={relation}
      title={name}
    />
  );
}

/** What they have complained about, and how much of it is still open. */
function ComplaintsSection({ membership }: { membership: ScannedMembership }) {
  const dates = useDates();
  const { complaints } = membership;

  if (complaints.total === 0) {
    return null;
  }

  return (
    <View>
      <SectionHeader
        subtitle={`${complaints.open} open of ${complaints.total}`}
        title="Complaints"
      />
      <Card padding="px-4 py-1">
        {complaints.recent.map((complaint, index) => (
          <View key={complaint.id}>
            {index === 0 ? null : <RowDivider inset />}
            <ListRow
              icon="chatbox-ellipses"
              onPress={() => router.push(`/complaints/${complaint.id}`)}
              right={<StatusPill status={complaint.status} />}
              subtitle={`${humanizeEnum(complaint.category)}${
                complaint.createdAt ? ` · ${dates.date(complaint.createdAt)}` : ""
              }`}
              title={complaint.title}
            />
          </View>
        ))}
      </Card>
    </View>
  );
}

/** The moon on the night-status card, themed rather than painted. */
function NightGlyph() {
  const { colors } = useAppTheme();

  return (
    <View className="h-10 w-10 items-center justify-center rounded-full bg-muted">
      <Glyph color={colors.mutedForeground} name="moon" size={18} />
    </View>
  );
}
