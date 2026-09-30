import * as Clipboard from "expo-clipboard";
import { Link2, MessageCircle, Share2 } from "lucide-react-native";
import { useCallback, useState } from "react";
import { Linking, Pressable, Share, View } from "react-native";

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
import { PLATFORM_NAME } from "@hostel/brand/brand";

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

function shareMessage(data: HostelInviteOverview) {
  return [
    `We run our hostel on ${PLATFORM_NAME}.`,
    data.theyGet.text
      ? `Register yours with our code ${data.code} and get ${data.theyGet.text} extra, free:`
      : `Register yours with our code ${data.code}:`,
    data.link,
  ].join(" ");
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

  const copy = useCallback(async (value: string, label: string) => {
    await Clipboard.setStringAsync(value);
    toastSuccess(label);
  }, []);

  const share = useCallback(async () => {
    try {
      await Share.share({ message: shareMessage(data) });
    } catch {
      // Dismissed. The code is on screen and copyable.
    }
  }, [data]);

  const whatsapp = useCallback(() => {
    void Linking.openURL(`https://wa.me/?text=${encodeURIComponent(shareMessage(data))}`).catch(
      () => void share(),
    );
  }, [data, share]);

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

        <Card className="items-center gap-3">
          <Text variant="label">Your hostel&apos;s code</Text>
          <Pressable
            accessibilityHint="Copies the code"
            accessibilityLabel={`Referral code ${data.code}`}
            accessibilityRole="button"
            className="active:opacity-70"
            onPress={() => void copy(data.code, "Code copied")}
          >
            <Text
              className="text-center"
              style={{ color: colors.primary, fontSize: 32, fontWeight: "800", letterSpacing: 4 }}
            >
              {data.code}
            </Text>
          </Pressable>
          <Text className="text-center" numberOfLines={1} variant="caption">
            {data.link}
          </Text>

          <Button className="w-full" icon={Share2} label="Share" onPress={() => void share()} />
          <View className="w-full flex-row gap-2">
            <Button className="flex-1" icon={MessageCircle} label="WhatsApp" onPress={whatsapp} variant="outline" />
            <Button
              className="flex-1"
              icon={Link2}
              label="Copy link"
              onPress={() => void copy(data.link, "Link copied")}
              variant="outline"
            />
          </View>
        </Card>

        <View className="flex-row gap-3">
          <Card className="flex-1 gap-1 p-3">
            <Text variant="caption">They get</Text>
            <Text variant="label">{data.theyGet.text || "Nothing extra"}</Text>
          </Card>
          <Card className="flex-1 gap-1 p-3">
            <Text variant="caption">You get, per hostel</Text>
            <Text variant="label">{data.youGet.text || "Nothing extra"}</Text>
          </Card>
        </View>

        <Card padding="px-4 py-1">
          <ListRow
            icon="mail-outline"
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
                    icon="business-outline"
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
