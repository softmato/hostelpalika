import { useState } from "react";
import { Linking, Pressable, Switch, View } from "react-native";

import { SosOverlay } from "@/components/sos-overlay";
import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Glyph } from "@/components/ui/glyph";
import { Input } from "@/components/ui/input";
import { RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";

import { useAppTheme } from "@/hooks/use-app-theme";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { useSos } from "@/hooks/use-sos";
import {
  type EmergencyContact,
  type SosAlert,
} from "@/lib/safety-api";
import {
  describeSosStatus,
  SOS_COUNTDOWN_SECONDS,
  SOS_MESSAGE_MAX,
  sosMessagePayload,
  validateSosMessage,
} from "@/lib/sos";
import { residentQuery } from "@/lib/resident-queries";

/**
 * The considered half of SOS: a note, who hears about it, and the numbers to
 * ring. The long press on Home's `<SosHeaderButton>` is the other half and skips
 * all of it.
 *
 * ## The phone numbers are the point of this screen
 *
 * They are listed first, above the alert control, and they are tappable. An app
 * alert depends on someone else's phone being charged, unlocked and in a
 * signal; a phone call does not. If this screen only ever gets someone to a
 * number faster, it has done its job.
 *
 * ## The history is the record, and it is why the home card can let go
 *
 * Home flags an SOS for a day, and drops the flag the moment staff settle it —
 * see `sosIsFlagged`. That is only defensible because nothing is lost when it
 * goes: `GET /resident/sos` lists every alert this resident has ever raised and
 * what the hostel did with each one, and `updateSOSAlertStatus` moves a row's
 * status without deleting anything.
 *
 * ## Contacts are read-only, and that is the server's shape
 *
 * `GET /resident/emergency-contacts` has no sibling POST or DELETE — the only
 * `EmergencyContactModel.create` in the repo is inside admin resident creation.
 * So there is no Add button here. Drawing one would be a control the server
 * ignores, and the resident would believe a number was saved that was not.
 */

function ContactRow({ contact }: { contact: EmergencyContact }) {
  const { colors } = useAppTheme();

  return (
    <Pressable
      accessibilityHint={`Calls ${contact.phone}`}
      accessibilityLabel={`Call ${contact.name}`}
      accessibilityRole="button"
      className="min-h-14 flex-row items-center gap-3 py-3 active:opacity-70"
      onPress={() => {
        void Linking.openURL(`tel:${contact.phone}`);
      }}
    >
      <View
        className="h-10 w-10 items-center justify-center rounded-full"
        style={{ backgroundColor: `${colors.destructive}1A` }}
      >
        <Glyph color={colors.destructive} name="call" size={18} />
      </View>

      <View className="flex-1">
        <View className="flex-row items-center gap-2">
          <Text variant="label">{contact.name}</Text>
          {contact.isPrimary ? (
            <View className="rounded-full bg-muted px-2 py-0.5">
              <Text variant="caption">Primary</Text>
            </View>
          ) : null}
        </View>
        <Text variant="caption">
          {[contact.relation, contact.phone].filter(Boolean).join(" · ")}
        </Text>
      </View>

      <Glyph color={colors.destructive} name="chevron-forward" size={18} />
    </Pressable>
  );
}

/**
 * One past alert: when it was raised, what was said, and where it got to.
 *
 * No chevron and nothing to tap. There is no resident-facing action on a past
 * alert — they cannot reopen one and they cannot close one — so a row that
 * looked pressable would be a promise the server does not keep.
 */
function AlertRow({ alert }: { alert: SosAlert }) {
  const dates = useDates();
  const state = describeSosStatus(alert.status);

  return (
    <View className="gap-1.5 py-3">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="flex-1" numberOfLines={1} variant="label">
          {alert.createdAt ? dates.dateTime(alert.createdAt) : "Alert raised"}
        </Text>

        <Badge label={state.label} tone={state.tone} />
      </View>

      {alert.message ? <Text variant="muted">{alert.message}</Text> : null}

      <Text variant="caption">
        {alert.guardianAlertEnabled
          ? "Hostel staff and your guardians were alerted."
          : "Hostel staff were alerted."}
      </Text>
    </View>
  );
}

/**
 * The rows these cards load into, without a card around them — the `<Card>` is
 * already on the screen, and `SkeletonCard` would draw a second border inside
 * the first.
 */
function ContactRowsSkeleton() {
  return (
    <View className="gap-3 py-1">
      {[0, 1, 2].map((row) => (
        <View className="flex-row items-center gap-3" key={row}>
          <Skeleton height={36} radius={18} width={36} />
          <View className="flex-1 gap-1.5">
            <Skeleton height={12} width="70%" />
            <Skeleton height={10} width="40%" />
          </View>
        </View>
      ))}
    </View>
  );
}

export default function SosScreen() {
  const { colors } = useAppTheme();
  const sos = useSos();
  // The numbers on this screen are maintained by the hostel, so `safety` is the
  // only way they change while a resident is looking at them.
  const contactsQuery = residentQuery.emergencyContacts();
  const contacts = useResource(contactsQuery.load, {
    cacheKey: contactsQuery.key,
    topics: contactsQuery.topics,
  });
  /*
    Same topic, which is what keeps this list honest without an effect watching
    the countdown: `triggerSOS` and `updateSOSAlertStatus` both publish a
    `safety` change on the hostel channel, so an alert this resident just raised
    — and a settlement a warden just made — arrive here on their own.
  */
  const alertsQuery = residentQuery.sosAlerts();
  const alerts = useResource(alertsQuery.load, {
    cacheKey: alertsQuery.key,
    topics: alertsQuery.topics,
  });

  const [message, setMessage] = useState("");
  const [alertGuardians, setAlertGuardians] = useState(true);

  const messageError = validateSosMessage(message);
  const rows = contacts.data?.contacts ?? [];
  const history = alerts.data ?? [];

  return (
    <Screen
      header={<AppBar showBack title="Emergency" />}
      onRefresh={() => {
        contacts.refresh();
        alerts.refresh();
      }}
      refreshing={contacts.refreshing || alerts.refreshing}
      scroll
    >
      <View className="gap-5 pt-1">
        <View>
          <SectionHeader
            subtitle="Tap to call. A phone call does not need their app to be open."
            title="Your emergency contacts"
          />

          <Card>
            {contacts.loading ? (
              <ContactRowsSkeleton />
            ) : contacts.error ? (
              <ErrorState message={contacts.error} onRetry={contacts.reload} />
            ) : rows.length === 0 ? (
              /*
                Not an `EmptyState` with an Add button: there is no endpoint to
                add one. The honest instruction is who to ask.
              */
              <View className="gap-1 py-2">
                <Text variant="label">No contacts on file</Text>
                <Text variant="caption">
                  Your hostel records these when you move in. Ask the office to
                  add someone — they can&apos;t be added from the app yet.
                </Text>
              </View>
            ) : (
              rows.map((contact, index) => (
                <View key={contact.id}>
                  {index > 0 ? <RowDivider inset /> : null}
                  <ContactRow contact={contact} />
                </View>
              ))
            )}
          </Card>
        </View>

        <View>
          <SectionHeader
            subtitle="Alerts hostel staff straight away, with your name and room."
            title="Send an alert"
          />

          <Card className="gap-4">
            <Input
              hint={`Optional. ${SOS_MESSAGE_MAX - message.trim().length} characters left.`}
              error={messageError}
              multiline
              numberOfLines={3}
              onChangeText={setMessage}
              placeholder="What's happening? (optional)"
              style={{ height: 76, textAlignVertical: "top" }}
              value={message}
            />

            <View className="flex-row items-center gap-3">
              <View className="flex-1">
                <Text variant="label">Also alert my guardians</Text>
                <Text variant="caption">
                  {/*
                    Named honestly: guardians are only reachable if the hostel
                    has registered one with contact details, and the fan-out
                    reports afterwards how many were actually told.
                  */}
                  Anyone your hostel has registered as a guardian for you.
                </Text>
              </View>

              <Switch
                onValueChange={setAlertGuardians}
                thumbColor={colors.background}
                trackColor={{ false: colors.border, true: colors.destructive }}
                value={alertGuardians}
              />
            </View>

            <Button
              disabled={Boolean(messageError)}
              haptic={false}
              label="Send emergency alert"
              onPress={() =>
                sos.arm({
                  guardianAlertEnabled: alertGuardians,
                  message: sosMessagePayload(message),
                })
              }
              size="lg"
              variant="danger"
            />

            <Text className="text-center" variant="caption">
              {`You'll get ${SOS_COUNTDOWN_SECONDS} seconds to cancel. Once it's sent, only hostel staff can close it.`}
            </Text>
          </Card>
        </View>

        {/*
          Last, because it is the one part of this screen nobody opens it for.
          It is drawn only when there is something to draw — a resident who has
          never raised an alert does not need a heading telling them so.
        */}
        {alerts.loading || history.length > 0 ? (
          <View>
            <SectionHeader
              subtitle="Every alert you have raised, and what your hostel did with it."
              title="Your past alerts"
            />

            <Card>
              {alerts.loading ? (
                <ContactRowsSkeleton />
              ) : (
                history.map((alert, index) => (
                  <View key={alert.id}>
                    {index > 0 ? <RowDivider /> : null}
                    <AlertRow alert={alert} />
                  </View>
                ))
              )}
            </Card>
          </View>
        ) : null}
      </View>

      <SosOverlay sos={sos} />
    </Screen>
  );
}
