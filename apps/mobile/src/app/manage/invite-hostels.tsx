import { useCallback, useState } from "react";
import { View } from "react-native";

import { HostelInviteCard } from "@/components/manage/hostel-invite-card";
import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonCard } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { type HostelInviteOverview, sendHostelInvite } from "@/lib/admin-manage-api";
import { adminQuery } from "@/lib/admin-queries";
import { readApiError } from "@/lib/api-contract";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Invite hostels — the web portal's `invite-hostels` screen.
 *
 * The code belongs to the hostel, not to whoever opened this screen: owner and
 * wardens see the same one, and a hostel that registers with it rewards this
 * hostel whoever shared it. Opening the screen is what makes the code.
 *
 * The share carries the link as well as the code: `/register-hostel?ref=` opens
 * the website's registration with the code already filled in, and someone
 * registering in the app types the code at "Do you have a referral code?".
 */
export default function InviteHostelsScreen() {
  const query = adminQuery.hostelInvites();
  const invites = useResource<HostelInviteOverview>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  const header = <AppBar accent centerTitle showBack title="Invite hostels" />;

  if (invites.loading) {
    return (
      <Screen header={header}>
        <View className="gap-4 pt-1">
          <SkeletonCard rows={3} />
          <SkeletonCard rows={2} />
        </View>
      </Screen>
    );
  }

  if (invites.error || !invites.data) {
    return (
      <Screen header={header}>
        <ErrorState
          message={invites.error ?? "Your referral code could not be loaded."}
          onRetry={invites.reload}
        />
      </Screen>
    );
  }

  return <InviteBody data={invites.data} header={header} resource={invites} />;
}

function InviteBody({
  data,
  header,
  resource,
}: {
  data: HostelInviteOverview;
  header: React.ReactNode;
  resource: { refresh: () => void; refreshing: boolean };
}) {
  const { colors } = useAppTheme();
  const dates = useDates();
  const [emailOpen, setEmailOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [sending, setSending] = useState(false);

  const sendEmail = useCallback(async () => {
    setSending(true);

    try {
      await sendHostelInvite({ email: email.trim(), name: name.trim() || undefined });
      toastSuccess("Invite sent", email.trim());
      setEmail("");
      setName("");
      setEmailOpen(false);
    } catch (error) {
      toastError("Could not send", readApiError(error));
    } finally {
      setSending(false);
    }
  }, [email, name]);

  return (
    <Screen header={header} onRefresh={resource.refresh} refreshing={resource.refreshing} scroll>
      <View className="gap-5 pt-1">
        {data.enabled ? null : (
          <Card className="bg-warning/10">
            <Text variant="muted">Hostel referrals are paused right now. Codes will work again once they restart.</Text>
          </Card>
        )}

        <HostelInviteCard data={data} />

        <Card padding="px-4 py-1">
          <ListRow
            icon="mail"
            iconBgColor={colors.primary}
            onPress={() => setEmailOpen(true)}
            subtitle="We email them your link and code"
            title="Invite by email"
          />
        </Card>

        <View>
          <SectionHeader subtitle="Extra time lands once they go live" title="Hostels you invited" />
          {data.referrals.length === 0 ? (
            <EmptyCard
              description="When a hostel registers with your code it shows up here."
              title="No hostels yet"
            />
          ) : (
            <Card padding="px-4 py-1">
              {data.referrals.map((referral, index) => (
                <View key={referral.id}>
                  {index > 0 ? <RowDivider inset /> : null}
                  <ListRow
                    icon="business"
                    right={
                      <Badge
                        label={
                          referral.status === "PENDING"
                            ? "Not live yet"
                            : referral.rewardAdded
                              ? `${referral.rewardText || "Live"} added`
                              : "Live"
                        }
                        tone={referral.status === "LIVE" ? "success" : "warning"}
                      />
                    }
                    subtitle={`Registered ${dates.relativeDay(referral.createdAt)}`}
                    title={referral.hostelName}
                  />
                </View>
              ))}
            </Card>
          )}
        </View>
      </View>

      <Sheet
        footer={
          <Button
            disabled={!email.includes("@")}
            label="Send invite"
            loading={sending}
            onPress={() => void sendEmail()}
          />
        }
        onClose={() => setEmailOpen(false)}
        open={emailOpen}
        title="Invite by email"
      >
        <View className="gap-3 pb-2">
          <Input autoCapitalize="words" label="Their name" onChangeText={setName} placeholder="Optional" value={name} />
          <Input
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            label="Email"
            onChangeText={setEmail}
            placeholder="owner@example.com"
            value={email}
          />
        </View>
      </Sheet>
    </Screen>
  );
}
