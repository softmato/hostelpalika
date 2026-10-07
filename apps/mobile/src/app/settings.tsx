import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import { Alert, Linking, View } from "react-native";

import { FingerprintLockSetting } from "@/components/app-lock";
import { CalendarPreferenceCard } from "@/components/calendar-preference";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { SkeletonCard } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { Toggle } from "@/components/ui/toggle";
import { useAppDispatch, useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import {
  type DeletionStatus,
  getDeletionStatus,
  requestAccountDeletion,
} from "@/lib/account-api";
import {
  canRequestDeletion,
  deletionReasonError,
  MAX_DELETION_REASON,
  PATHWAY_COPY,
} from "@/lib/account-pathways";
import { readApiError } from "@/lib/api-contract";
import { endSession } from "@/lib/auth-session";
import {
  describePreference,
  EMAIL_TOPICS,
  type EmailAudience,
  type EmailPreference,
  formatMinutes,
  MUTABLE_CATEGORIES,
  type NotificationPreference,
  parseMinutes,
} from "@/lib/notification-preferences";
import {
  getEmailPreference,
  getNotificationPreference,
  updateEmailPreference,
  updateNotificationPreference,
} from "@/lib/notification-preferences-api";
import {
  type PushPermission,
  registerPushToken,
  requestPushPermission,
} from "@/lib/push-notifications";
import { toastError, toastSuccess } from "@/lib/toast";
import { setThemePreference, type ThemePreference } from "@/store/slices/uiSlice";
import { APP_NAME } from "@/constants/branding";
import { ROLE } from "@/constants/roles";

/**
 * Settings — theme, notifications, privacy, and closing the account.
 *
 * The privacy half is a port of `apps/web/src/app/(auth)/account/privacy/page.tsx`
 * ("Privacy & your data" / "Control what … keeps about you") and the
 * `AccountDeletionPanel` inside it, including its four pathways and their copy
 * verbatim — see `lib/account-pathways.ts` for why that copy is not paraphrased.
 *
 * ## Theme and calendar are local; notifications are not
 *
 * **Theme** and **dates** are local by design: both live in `uiSlice` and
 * nothing is sent anywhere, because they describe this phone rather than this
 * person. The calendar picker is shared with the hostel portal's own settings
 * screen — see `components/calendar-preference.tsx` for why it is reachable
 * from both.
 * **Notification preferences** are the opposite — they decide what the *server*
 * sends, so they live on the server (`NotificationPreference`, read by
 * `push.service.ts` before every send). This section was a paragraph explaining
 * that no such model existed until 2026-08-18; every switch in it is now real.
 */

const THEME_OPTIONS: { icon: keyof typeof Ionicons.glyphMap; iconBgColor: string; hint: string; label: string; value: ThemePreference }[] = [
  { icon: "sunny-outline", iconBgColor: "#FF9500", hint: "The product's own look", label: "Light", value: "light" },
  { icon: "moon-outline", iconBgColor: "#5E5CE6", hint: "Easier at night", label: "Dark", value: "dark" },
  { icon: "phone-portrait-outline", iconBgColor: "#8E8E93", hint: "Follow your phone", label: "System", value: "system" },
];

/**
 * Which slice of this screen to draw.
 */
const SETTINGS_TITLES: Record<string, string> = {
  calendar: "Dates",
  notifications: "Notifications",
  privacy: "Privacy & your data",
  security: "Fingerprint lock",
};

export default function SettingsScreen() {
  const { section } = useLocalSearchParams<{ section?: string }>();
  const dispatch = useAppDispatch();
  const preference = useAppSelector((state) => state.ui.themePreference);
  const account = useAppSelector((state) => state.auth.account);
  const { colors } = useAppTheme();

  const deletion = useResource<DeletionStatus>(
    useCallback(() => getDeletionStatus(), []),
    { cacheKey: "account:deletion-status" },
  );

  const openPrivacyPolicy = useCallback(() => {
    router.push("/legal/privacy");
  }, []);

  const showAll = !section || !(section in SETTINGS_TITLES);
  const showNotifications = showAll || section === "notifications";
  const showPrivacy = showAll || section === "privacy";
  const showSecurity = showAll || section === "security";
  const showCalendar = showAll || section === "calendar";
  // Only these two roles are sent optional mail; nobody else gets the section.
  const emailAudience: EmailAudience | null =
    account?.role === ROLE.RESIDENT
      ? "resident"
      : account?.role === ROLE.HOSTEL_ADMIN
        ? "staff"
        : null;

  return (
    <Screen
      header={
        <AppBar showBack title={(section && SETTINGS_TITLES[section]) || "Settings"} />
      }
      onRefresh={showPrivacy ? deletion.refresh : undefined}
      refreshing={showPrivacy && deletion.refreshing}
      scroll
    >
      <View className="gap-5 pt-1 pb-10">
        {showAll && account ? (
          <Card className="flex-row items-center gap-3 bg-card p-3.5 shadow-sm">
            <View className="h-14 w-14 items-center justify-center rounded-full bg-primary/10">
              <Ionicons color={colors.primary} name="person" size={28} />
            </View>
            <View className="flex-1 gap-0.5">
              <Text className="text-lg font-bold text-foreground" numberOfLines={1}>
                {account.name || "Account Profile"}
              </Text>
              <Text numberOfLines={1} variant="caption">
                {account.email || "Account & Security settings"}
              </Text>
            </View>
            <Ionicons color={colors.mutedForeground} name="chevron-forward" size={18} />
          </Card>
        ) : null}

        {showAll ? (
          <View>
            <SectionHeader subtitle="Stored on this phone only" title="Appearance" />
            <Card>
              {THEME_OPTIONS.map((option, index) => {
                const active = option.value === preference;

                return (
                  <View key={option.value}>
                    {index > 0 ? <RowDivider inset /> : null}
                    <ListRow
                      icon={option.icon}
                      iconBgColor={option.iconBgColor}
                      onPress={() => dispatch(setThemePreference(option.value))}
                      right={
                        <Ionicons
                          color={active ? colors.primary : colors.border}
                          name={active ? "radio-button-on" : "radio-button-off"}
                          size={20}
                        />
                      }
                      subtitle={option.hint}
                      title={option.label}
                    />
                  </View>
                );
              })}
            </Card>
          </View>
        ) : null}

        {showSecurity ? <FingerprintLockSetting /> : null}

        {showCalendar ? <CalendarPreferenceCard /> : null}

        {showNotifications ? <NotificationSettings /> : null}

        {showNotifications && emailAudience ? <EmailSettings audience={emailAudience} /> : null}

        {showPrivacy ? (
          <View>
            <SectionHeader
              subtitle="Control what we keep about you"
              title="Privacy & your data"
            />
            <Card>
              <ListRow
                icon="document-text-outline"
                iconBgColor="#AF52DE"
                onPress={openPrivacyPolicy}
                subtitle="What we collect, why, and for how long"
                title="Privacy policy"
              />
              <RowDivider inset />
              <ListRow
                icon="location-outline"
                iconBgColor="#34C759"
                onPress={() => router.push("/attendance")}
                subtitle="See what has been recorded, stop it, or delete it"
                title="Location & attendance"
              />
            </Card>
          </View>
        ) : null}

        {showPrivacy ? (
          deletion.loading ? (
            <SkeletonCard rows={2} />
          ) : deletion.error || !deletion.data ? (
            <ErrorState
              message={deletion.error ?? "Your account settings could not be loaded."}
              onRetry={deletion.reload}
            />
          ) : (
            <DeletionPanel onChanged={deletion.refresh} status={deletion.data} />
          )
        ) : null}

        {/* Search Affordance Bar matching iOS Settings layout */}
        {showAll ? (
          <View className="mt-2 flex-row items-center gap-2 rounded-2xl border border-border/80 bg-card px-4 py-2.5 shadow-sm">
            <Ionicons color={colors.mutedForeground} name="search-outline" size={18} />
            <Text className="flex-1 text-sm text-muted-foreground">Search settings</Text>
            <Ionicons color={colors.mutedForeground} name="mic-outline" size={18} />
          </View>
        ) : null}
      </View>
    </Screen>
  );
}

/**
 * Notifications — what may interrupt, and when.
 *
 * ## Every switch here is real
 *
 * This section used to be a paragraph explaining that no preference existed on
 * the server, because a toggle that reverted on the next fetch while the server
 * kept sending would have been worse than no toggle. `NotificationPreference`
 * and the check inside `push.service.ts` now exist, so these are controls.
 *
 * ## Saved on change, not behind a Save button
 *
 * A settings screen with a Save button loses the change of anyone who backs out,
 * and on a phone backing out is a gesture people make without deciding to. So
 * each switch PATCHes its own field, the UI moves first, and a failure puts the
 * old value back and says so. `updateNotificationPreference` takes a partial for
 * exactly this reason.
 *
 * ## Urgent is stated, not offered
 *
 * SOS overrides the master switch, quiet hours and any mute — server-side, in
 * `shouldPush`. So the screen says so plainly and `MUTABLE_CATEGORIES` has no SOS
 * row: a switch the server ignores is a lie, and this is the one place where
 * believing it could matter.
 *
 * ## Times are typed, not picked
 *
 * A wheel picker means a native module and a modal for a value people set once.
 * A 5-character field with `parseMinutes` guarding it is the smaller thing that
 * does the same job — and it is checked before the PATCH, so a typo is an inline
 * message rather than a 400.
 */
function NotificationSettings() {
  const resource = useResource<NotificationPreference>(
    useCallback(() => getNotificationPreference(), []),
    { cacheKey: "account:notification-preference" },
  );

  const [saving, setSaving] = useState(false);
  /*
   * The OS-level permission, which is a separate thing from the server-side
   * preference below. Someone can have `pushEnabled: true` saved and still
   * receive nothing because the phone is blocking it — so both are shown, and
   * the one that is actually in the way is the one offered a button.
   *
   * Read without asking (`ask` defaults to false), so opening Settings never
   * fires the system dialogue on its own.
   */
  const [permission, setPermission] = useState<PushPermission | null>(null);

  useFocusEffect(
    useCallback(() => {
      // On focus rather than on mount: the blocked case sends people to system
      // settings, and they come back to this screen expecting it to have noticed.
      let cancelled = false;

      void requestPushPermission().then((next) => {
        if (!cancelled) {
          setPermission(next);
        }
      });

      return () => {
        cancelled = true;
      };
    }, []),
  );

  /*
   * Registering the token is a round trip — the OS prompt, then our own
   * `POST /notifications/token` — and the button said nothing for either. On a
   * phone that takes its time about the permission dialogue that reads as a
   * button that did not register the tap.
   */
  const [enabling, setEnabling] = useState(false);

  const enablePush = useCallback(async () => {
    if (permission === "blocked") {
      // The dialogue will never appear again, so the only route left is the
      // phone's own settings page for this app.
      await Linking.openSettings();
      return;
    }

    setEnabling(true);

    try {
      const result = await registerPushToken({ ask: true, force: true });

      setPermission(result.permission);

      if (result.permission === "granted") {
        toastSuccess("Notifications on", "This phone will get alerts from now on.");
      }
    } finally {
      setEnabling(false);
    }
  }, [permission]);

  const preference = resource.data;

  const patch = useCallback(
    (next: Partial<NotificationPreference>) => {
      const previous = preference;

      if (!previous) {
        return;
      }

      // Optimistic: the switch moves under the thumb that pressed it. Anything
      // slower reads as the control being broken.
      resource.setData((current) => (current ? { ...current, ...next } : current));
      setSaving(true);

      void updateNotificationPreference(next)
        .then((saved) => resource.setData(() => saved))
        .catch((caught: unknown) => {
          resource.setData(() => previous);
          toastError("Couldn't save that", readApiError(caught));
        })
        .finally(() => setSaving(false));
    },
    [preference, resource],
  );

  if (resource.loading) {
    return (
      <View>
        <SectionHeader title="Notifications" />
        <SkeletonCard rows={3} />
      </View>
    );
  }

  if (resource.error || !preference) {
    return (
      <View>
        <SectionHeader title="Notifications" />
        <ErrorState
          message={resource.error ?? "Your notification settings could not be loaded."}
          onRetry={resource.reload}
        />
      </View>
    );
  }

  return (
    <View>
      <SectionHeader subtitle={describePreference(preference)} title="Notifications" />

      {/*
        The permission prompt lives here, and nowhere else.

        Nothing asks at boot: on Android 13+ a second refusal sets
        `canAskAgain: false` permanently, so the dialogue over a dashboard
        somebody has not read yet spends the app's one chance at the worst
        possible moment. Here it follows a sentence explaining what it is for.

        `blocked` gets different copy because it needs a different action — the
        dialogue will never appear again, and a button offering it would do
        nothing.
      */}
      {permission === "granted" || permission === "unsupported" ? null : (
        <View className="pb-3">
          <Card className="gap-2">
            <Text variant="label">
              {permission === "blocked"
                ? "Notifications are switched off for this app"
                : "Let us notify this phone"}
            </Text>
            <Text variant="muted">
              {permission === "blocked"
                ? `Your phone is blocking them, so we cannot ask again from here. Turn them back on in your phone's settings for ${APP_NAME}.`
                : "Rent reminders, meal announcements and safety alerts arrive as they happen. Everything below still applies once it is on."}
            </Text>
            <Button
              label={permission === "blocked" ? "Open phone settings" : "Turn on notifications"}
              loading={enabling}
              onPress={() => void enablePush()}
              variant="outline"
            />
          </Card>
        </View>
      )}

      <Card>
        <ListRow
          icon="notifications-outline"
          iconBgColor="#FF3B30"
          right={
            <Toggle
              accessibilityLabel="Push notifications"
              disabled={saving}
              onChange={(next) => patch({ pushEnabled: next })}
              value={preference.pushEnabled}
            />
          }
          subtitle="Alerts on your phone. The bell in the app is unaffected."
          title="Push notifications"
        />

        <RowDivider inset />

        <ListRow
          icon="moon-outline"
          iconBgColor="#5E5CE6"
          right={
            <Toggle
              accessibilityLabel="Quiet hours"
              disabled={saving || !preference.pushEnabled}
              onChange={(next) => patch({ quietHoursEnabled: next })}
              value={preference.quietHoursEnabled}
            />
          }
          subtitle="Hold everything except urgent alerts overnight"
          title="Quiet hours"
        />

        {preference.quietHoursEnabled && preference.pushEnabled ? (
          <View className="flex-row gap-3 pb-3 pt-1">
            <View className="flex-1">
              <TimeField
                label="From"
                onCommit={(minutes) => patch({ quietHoursStart: minutes })}
                value={preference.quietHoursStart}
              />
            </View>
            <View className="flex-1">
              <TimeField
                label="Until"
                onCommit={(minutes) => patch({ quietHoursEnd: minutes })}
                value={preference.quietHoursEnd}
              />
            </View>
          </View>
        ) : null}
      </Card>

      <View className="pt-3">
        <Card>
          <Text className="pb-1" variant="label">
            Mute a type
          </Text>
          <Text className="pb-2" variant="muted">
            You will still see these in the app — this only stops the buzz.
          </Text>

          {MUTABLE_CATEGORIES.map((category, index) => {
            const muted = preference.mutedCategories.includes(category.value);
            const categoryIcons: Record<string, { bg: string; icon: keyof typeof Ionicons.glyphMap }> = {
              ANNOUNCEMENT: { bg: "#007AFF", icon: "megaphone-outline" },
              ATTENDANCE: { bg: "#34C759", icon: "location-outline" },
              COMPLAINT: { bg: "#FF9500", icon: "chatbox-ellipses-outline" },
              FINANCE: { bg: "#30D158", icon: "cash-outline" },
              MAINTENANCE: { bg: "#8E8E93", icon: "construct-outline" },
              FOOD: { bg: "#FF2D55", icon: "restaurant-outline" },
            };

            const config = categoryIcons[category.value] ?? { bg: "#5856D6", icon: "notifications-outline" };

            return (
              <View key={category.value}>
                {index > 0 ? <RowDivider inset /> : null}
                <ListRow
                  icon={config.icon}
                  iconBgColor={config.bg}
                  right={
                    <Toggle
                      accessibilityLabel={`Mute ${category.label}`}
                      disabled={saving || !preference.pushEnabled}
                      onChange={(next) =>
                        patch({
                          mutedCategories: next
                            ? [...preference.mutedCategories, category.value]
                            : preference.mutedCategories.filter(
                                (value) => value !== category.value,
                              ),
                        })
                      }
                      value={muted}
                    />
                  }
                  subtitle={category.description}
                  title={category.label}
                />
              </View>
            );
          })}
        </Card>
      </View>

      <View className="pt-3">
        <Card className="gap-1">
          <Text variant="label">Urgent alerts always come through</Text>
          <Text variant="muted">
            An SOS reaches your phone whatever is set here — through quiet hours, a
            muted type, and with push switched off. Nothing on this screen can
            silence one, on purpose.
          </Text>
        </Card>
      </View>
    </View>
  );
}

/**
 * Emails — which optional mail the server sends this account.
 *
 * Same contract as the push switches above: saved on change, optimistic, the
 * old value back on failure. The switch reads "on = you get these", unlike the
 * push mutes, because here the question is "do you want this email", not "should
 * it buzz". The server writes the answer to every address the account is mailed
 * at, and the same topics are behind the unsubscribe link in each email.
 *
 * Only the role's own topics are shown — a resident is never sent a payment
 * summary. Other roles never mount this; an account with no address hides it.
 */
function EmailSettings({ audience }: { audience: EmailAudience }) {
  const resource = useResource<EmailPreference>(
    useCallback(() => getEmailPreference(), []),
    { cacheKey: "account:email-preference" },
  );
  const [saving, setSaving] = useState(false);
  const preference = resource.data;

  const toggle = useCallback(
    (topic: string, receive: boolean) => {
      const previous = preference;

      if (!previous) {
        return;
      }

      const mutedTopics = receive
        ? previous.mutedTopics.filter((value) => value !== topic)
        : [...previous.mutedTopics, topic];

      resource.setData((current) => (current ? { ...current, mutedTopics } : current));
      setSaving(true);

      void updateEmailPreference(mutedTopics)
        .then((saved) => resource.setData(() => saved))
        .catch((caught: unknown) => {
          resource.setData(() => previous);
          toastError("Couldn't save that", readApiError(caught));
        })
        .finally(() => setSaving(false));
    },
    [preference, resource],
  );

  if (resource.loading) {
    return (
      <View>
        <SectionHeader title="Emails" />
        <SkeletonCard rows={3} />
      </View>
    );
  }

  if (resource.error || !preference) {
    return (
      <View>
        <SectionHeader title="Emails" />
        <ErrorState
          message={resource.error ?? "Your email settings could not be loaded."}
          onRetry={resource.reload}
        />
      </View>
    );
  }

  if (!preference.hasEmail) {
    return null;
  }

  const topicIcons: Record<string, { bg: string; icon: keyof typeof Ionicons.glyphMap }> = {
    ATTENDANCE_ALERTS: { bg: "#34C759", icon: "location-outline" },
    COMPLAINT_ALERTS: { bg: "#FF9500", icon: "chatbox-ellipses-outline" },
    COMPLAINT_UPDATES: { bg: "#FF9500", icon: "chatbox-ellipses-outline" },
    NOTICES: { bg: "#007AFF", icon: "megaphone-outline" },
    PAYMENT_SUMMARY: { bg: "#30D158", icon: "cash-outline" },
    RENT_REMINDERS: { bg: "#30D158", icon: "calendar-outline" },
  };

  return (
    <View>
      <SectionHeader subtitle="Turning one off keeps it in the app" title="Emails" />
      <Card>
        {EMAIL_TOPICS.filter((topic) => topic.audience === audience).map((topic, index) => {
          const config = topicIcons[topic.value] ?? { bg: "#5856D6", icon: "mail-outline" };

          return (
            <View key={topic.value}>
              {index > 0 ? <RowDivider inset /> : null}
              <ListRow
                icon={config.icon}
                iconBgColor={config.bg}
                right={
                  <Toggle
                    accessibilityLabel={`${topic.label} emails`}
                    disabled={saving}
                    onChange={(next) => toggle(topic.value, next)}
                    value={!preference.mutedTopics.includes(topic.value)}
                  />
                }
                subtitle={topic.description}
                title={topic.label}
              />
            </View>
          );
        })}
      </Card>
      <Text className="px-1 pt-2" variant="caption">
        Receipts, sign-in codes, billing and safety emails are always sent.
      </Text>
    </View>
  );
}

/**
 * One end of the quiet-hours window.
 *
 * Held as text while it is being typed and only committed on blur: parsing every
 * keystroke means "0" is a valid partial that would PATCH `00:00` before the
 * hour is finished. An unparseable value snaps back to what was saved, so the
 * field can never be left showing something the server does not hold.
 */
function TimeField({
  label,
  onCommit,
  value,
}: {
  label: string;
  onCommit: (minutes: number) => void;
  value: number;
}) {
  const [draft, setDraft] = useState(() => formatMinutes(value));
  const [error, setError] = useState<string | null>(null);

  const commit = useCallback(() => {
    const minutes = parseMinutes(draft);

    if (minutes === null) {
      setDraft(formatMinutes(value));
      setError(null);
      return;
    }

    setError(null);

    if (minutes !== value) {
      onCommit(minutes);
    }
  }, [draft, onCommit, value]);

  return (
    <Input
      error={error ?? undefined}
      keyboardType="numbers-and-punctuation"
      label={label}
      maxLength={5}
      onBlur={commit}
      onChangeText={setDraft}
      placeholder="22:00"
      value={draft}
    />
  );
}

/**
 * Closing the account.
 *
 * The server decides what the button does (`resolvePathway`) and the client renders
 * that pathway's copy. **A resident with an `ACTIVE` or `PENDING` residency is
 * `BLOCKED`**, which makes it the likeliest state on this app — so that branch is
 * a real explanation rather than a disabled button.
 */
function DeletionPanel({
  onChanged,
  status,
}: {
  onChanged: () => void;
  status: DeletionStatus;
}) {
  const dates = useDates();

  const { colors } = useAppTheme();
  const copy = PATHWAY_COPY[status.pathway];

  const [composing, setComposing] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = useCallback(() => {
    const problem = deletionReasonError(reason, status.pathway);

    if (problem) {
      setError(problem);
      return;
    }

    setError(null);

    /*
     * The last gate before something that closes an account, revokes guardian
     * access, or goes to the platform owner — and the copy is pathway-specific
     * because the consequence is. Same double confirmation the web has.
     */
    Alert.alert(copy.confirmTitle, copy.confirmDescription, [
      { style: "cancel", text: "Keep my account" },
      {
        onPress: () => {
          setBusy(true);

          void requestAccountDeletion(reason.trim())
            .then(async (result) => {
              // The server's own message, which differs by pathway.
              toastSuccess("Request sent", result.message);
              setComposing(false);
              setReason("");

              /*
               * `SELF_SERVICE` closes the account on the spot, so the session in
               * memory is already dead — staying on a signed-in screen would show
               * a shell that 401s on every request. The other pathways change
               * nothing about signing in, so they simply refresh.
               */
              if (result.data.pathway === "SELF_SERVICE") {
                await endSession();
                router.replace("/(browse)");
                return;
              }

              onChanged();
            })
            .catch((caught: unknown) => setError(readApiError(caught)))
            .finally(() => setBusy(false));
        },
        style: "destructive",
        text: copy.action,
      },
    ]);
  }, [copy, onChanged, reason, status.pathway]);

  const open = status.request;

  return (
    <View>
      <SectionHeader title="Your account" />

      <Card className="gap-3">
        <View className="flex-row items-start gap-3">
          <View
            className="h-10 w-10 items-center justify-center rounded-full"
            style={{ backgroundColor: `${colors.destructive}1A` }}
          >
            <Ionicons color={colors.destructive} name="shield-outline" size={19} />
          </View>

          <View className="flex-1 gap-2">
            <Text variant="subtitle">{copy.heading}</Text>

            <Text variant="muted">
              {status.pathway === "BLOCKED" ? status.blockedReason : copy.body}
            </Text>

            {status.pathway === "PLATFORM_REVIEW" && status.hostelNames.length > 0 ? (
              <Text variant="caption">
                Attached to this account: {status.hostelNames.join(", ")}.
              </Text>
            ) : null}
          </View>
        </View>

        {open ? (
          // An open request replaces the action entirely — there is nothing left
          // to ask for, and a second button would file a duplicate.
          <View className="gap-1 rounded-xl border border-border bg-muted/40 p-3">
            {open.kind === "PLATFORM_REVIEW" ? (
              <Text variant="muted">
                Your request is with the platform owner
                {open.reviewStatus ? ` (${open.reviewStatus.toLowerCase()})` : ""}. Your
                account is unaffected in the meantime.
              </Text>
            ) : (
              <Text variant="muted">
                Your account is closed and will be erased on{" "}
                {open.scheduledDeletionAt
                  ? dates.date(open.scheduledDeletionAt)
                  : "the scheduled date"}
                . Use the link in your email to undo it.
              </Text>
            )}
          </View>
        ) : !canRequestDeletion(status.pathway) ? null : composing ? (
          <View className="gap-3 border-t border-border pt-3">
            <Input
              error={error}
              hint={`At least 10 characters. ${
                status.pathway === "PLATFORM_REVIEW"
                  ? "The platform owner reads this."
                  : "It helps us fix what drove you away."
              }`}
              label="Why are you leaving?"
              maxLength={MAX_DELETION_REASON}
              multiline
              onChangeText={setReason}
              placeholder="A sentence or two."
              style={{ height: 88, paddingTop: 12, textAlignVertical: "top" }}
              value={reason}
            />

            {/*
              Filled red only once the action is armed. A solid destructive button
              at rest would be the loudest thing on a screen that is otherwise three
              sections of ordinary rows; outlined asks, filled confirms.
            */}
            <Button
              haptic={false}
              label={copy.action}
              loading={busy}
              onPress={submit}
              variant="danger"
            />
            <Button
              label="Keep my account"
              onPress={() => {
                setComposing(false);
                setReason("");
                setError(null);
              }}
              variant="ghost"
            />
          </View>
        ) : (
          <View className="border-t border-border pt-3">
            <Button
              label={copy.action}
              onPress={() => setComposing(true)}
              variant="outline"
            />
          </View>
        )}
      </Card>
    </View>
  );
}
