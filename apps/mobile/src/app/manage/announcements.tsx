import { useCallback, useMemo, useState } from "react";
import { Pressable, View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { ChoiceChips } from "@/components/ui/choice-chips";
import { FloatingButton } from "@/components/ui/floating-button";
import { Input } from "@/components/ui/input";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonCard } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import type { AdminResident } from "@/lib/admin-api";
import { type NotificationCampaign, sendNotificationCampaign } from "@/lib/admin-manage-api";
import { adminQuery } from "@/lib/admin-queries";
import { readApiError } from "@/lib/api-contract";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Send a notification — the web portal's Notifications composer.
 *
 * A bell entry and a push to every resident, their guardians, or residents you
 * pick, now or a little later, with delivery and read counts afterwards. Push
 * notices (`manage/push-notices`) are the repeating reminders; this is the
 * one-off message.
 */

type Audience = "ALL" | "GUARDIANS" | "SPECIFIC";
type Priority = "LOW" | "NORMAL" | "HIGH" | "URGENT";

const AUDIENCES: readonly { label: string; value: Audience }[] = [
  { label: "All residents", value: "ALL" },
  { label: "Guardians", value: "GUARDIANS" },
  { label: "Pick residents", value: "SPECIFIC" },
];

const PRIORITIES: readonly { label: string; value: Priority }[] = [
  { label: "Low", value: "LOW" },
  { label: "Normal", value: "NORMAL" },
  { label: "High", value: "HIGH" },
  { label: "Urgent", value: "URGENT" },
];

const WHEN: readonly { label: string; value: string }[] = [
  { label: "Now", value: "0" },
  { label: "In 30 min", value: "30" },
  { label: "In 1 hour", value: "60" },
  { label: "In 3 hours", value: "180" },
];

const AUDIENCE_LABEL: Record<string, string> = {
  ALL: "All residents",
  GUARDIANS: "Guardians",
  RESIDENTS: "Residents",
  SPECIFIC: "Picked residents",
};

export default function AnnouncementsScreen() {
  const dates = useDates();
  const query = adminQuery.campaigns();
  const campaigns = useResource<NotificationCampaign[]>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });
  const residentsQuery = adminQuery.residents();
  const residents = useResource<AdminResident[]>(residentsQuery.load, {
    cacheKey: residentsQuery.key,
    topics: residentsQuery.topics,
  });

  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [audience, setAudience] = useState<Audience>("ALL");
  const [priority, setPriority] = useState<Priority>("NORMAL");
  const [when, setWhen] = useState("0");
  const [picked, setPicked] = useState<string[]>([]);
  const [sending, setSending] = useState(false);

  const active = useMemo(
    () => (residents.data ?? []).filter((resident) => resident.status === "ACTIVE"),
    [residents.data],
  );

  const reset = () => {
    setTitle("");
    setBody("");
    setAudience("ALL");
    setPriority("NORMAL");
    setWhen("0");
    setPicked([]);
  };

  const send = useCallback(async () => {
    if (title.trim().length < 2 || body.trim().length < 2) {
      toastError("Write the message", "A title and a message, both.");
      return;
    }

    if (audience === "SPECIFIC" && picked.length === 0) {
      toastError("Pick someone", "Tap the residents to send it to.");
      return;
    }

    setSending(true);

    try {
      const minutes = Number(when);
      const campaign = await sendNotificationCampaign({
        audience,
        body: body.trim(),
        priority,
        residentIds: audience === "SPECIFIC" ? picked : [],
        scheduledFor: minutes > 0 ? new Date(Date.now() + minutes * 60_000).toISOString() : undefined,
        title: title.trim(),
      });

      toastSuccess(
        campaign.status === "SCHEDULED" ? "Scheduled" : "Sent",
        campaign.status === "SCHEDULED"
          ? `Goes out ${dates.relativeDay(campaign.scheduledFor ?? "")}`
          : `To ${campaign.recipientCount} people`,
      );
      reset();
      setOpen(false);
      await campaigns.refresh();
    } catch (error) {
      toastError("Could not send", readApiError(error));
    } finally {
      setSending(false);
    }
  }, [audience, body, campaigns, dates, picked, priority, title, when]);

  const header = <AppBar accent centerTitle showBack title="Send a notification" />;

  return (
    <Screen
      floating={<FloatingButton icon="create-outline" label="New message" onPress={() => setOpen(true)} />}
      header={header}
      onRefresh={campaigns.refresh}
      refreshing={campaigns.refreshing}
      scroll
    >
      <View className="gap-5 pt-1">
        {campaigns.loading ? (
          <SkeletonCard rows={4} />
        ) : campaigns.error ? (
          <ErrorState message={campaigns.error} onRetry={campaigns.reload} />
        ) : (campaigns.data ?? []).length === 0 ? (
          <EmptyCard
            description="Tap New message to reach every resident's phone at once."
            title="Nothing sent yet"
          />
        ) : (
          <View>
            <SectionHeader title="Sent and scheduled" />
            <Card padding="px-4 py-1">
              {(campaigns.data ?? []).map((campaign, index) => (
                <View key={campaign.id}>
                  {index > 0 ? <RowDivider inset /> : null}
                  <ListRow
                    right={
                      campaign.status === "SCHEDULED" ? (
                        <Badge label="Scheduled" tone="warning" />
                      ) : (
                        <Text variant="caption">
                          {campaign.stats.read}/{campaign.recipientCount} read
                        </Text>
                      )
                    }
                    subtitle={`${AUDIENCE_LABEL[campaign.audience] ?? campaign.audience} · ${dates.relativeDay(
                      campaign.sentAt ?? campaign.scheduledFor ?? campaign.createdAt ?? "",
                    )}`}
                    title={campaign.title}
                  />
                </View>
              ))}
            </Card>
          </View>
        )}
      </View>

      <Sheet
        footer={
          <Button
            label={when === "0" ? "Send now" : "Schedule"}
            loading={sending}
            onPress={() => void send()}
          />
        }
        onClose={() => setOpen(false)}
        open={open}
        tall
        title="New message"
      >
        <View className="gap-4 pb-2">
          <Input label="Title" onChangeText={setTitle} placeholder="Water off tomorrow" value={title} />
          <Input
            label="Message"
            multiline
            onChangeText={setBody}
            placeholder="From 10 AM to 2 PM while the tank is cleaned."
            style={{ height: 110 }}
            value={body}
          />
          <ChoiceChips columns={3} label="To" onToggle={setAudience} options={AUDIENCES} value={audience} />
          {audience === "SPECIFIC" ? (
            <View className="flex-row flex-wrap gap-2">
              {active.map((resident) => {
                const on = picked.includes(resident.id);

                return (
                  <Pressable
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: on }}
                    className={`rounded-full border px-3 py-1.5 ${on ? "border-primary bg-primary/10" : "border-border"}`}
                    key={resident.id}
                    onPress={() =>
                      setPicked((current) =>
                        on ? current.filter((id) => id !== resident.id) : [...current, resident.id],
                      )
                    }
                  >
                    <Text variant="label">{`${resident.firstName} ${resident.lastName}`.trim()}</Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}
          <ChoiceChips columns={4} label="Priority" onToggle={setPriority} options={PRIORITIES} value={priority} />
          <ChoiceChips columns={4} label="When" onToggle={setWhen} options={WHEN} value={when} />
        </View>
      </Sheet>
    </Screen>
  );
}
