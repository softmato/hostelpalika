import { useCallback, useState } from "react";
import { Linking, View } from "react-native";

import { Quiet, Rows, TintRow, type Tint } from "@/components/platform-ui";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { FactRow } from "@/components/ui/layout";
import { Screen } from "@/components/ui/screen";
import { Segmented } from "@/components/ui/segmented";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonRows } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import type { GlyphName } from "@hostel/constants/glyphs";
import { readableRole, type Role } from "@/constants/roles";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { readApiError } from "@/lib/api-contract";
import { openAssetViewer } from "@/lib/asset-viewer";
import { type FeedbackItem, type FeedbackStatus, listFeedback, setFeedbackStatus } from "@/lib/platform-admin-api";
import { toastError } from "@/lib/toast";

/**
 * Feedback — bugs, ideas and notes sent from every app and portal (web
 * `platform-feedback-page`). New first; opening one marks it seen, Done files it.
 */

const KIND: Record<FeedbackItem["kind"], { icon: GlyphName; label: string; tone: Tint }> = {
  BUG: { icon: "alert-circle", label: "Bug", tone: "danger" },
  FEEDBACK: { icon: "chatbubbles", label: "Feedback", tone: "brand" },
  IMPROVEMENT: { icon: "bulb", label: "Idea", tone: "warning" },
};

export default function FeedbackScreen() {
  const dates = useDates();
  const [filter, setFilter] = useState<FeedbackStatus>("NEW");
  const load = useCallback(() => listFeedback(filter), [filter]);
  const list = useResource(load, { cacheKey: `platform:feedback:${filter}` });
  const [open, setOpen] = useState<FeedbackItem | null>(null);
  const counts = list.data?.counts ?? {};

  async function move(item: FeedbackItem, status: FeedbackStatus) {
    try {
      await setFeedbackStatus(item.id, status);
      list.refresh();
    } catch (error) {
      toastError("Not saved", readApiError(error));
    }
  }

  function show(item: FeedbackItem) {
    setOpen(item);
    if (item.status === "NEW") void move(item, "SEEN");
  }

  return (
    <Screen header={<AppBar showBack title="Feedback" />} onRefresh={list.refresh} refreshing={list.refreshing} scroll>
      <View className="gap-4">
        <Segmented
          onChange={setFilter}
          options={[
            { count: counts.NEW, label: "New", value: "NEW" },
            { count: counts.SEEN, label: "Seen", value: "SEEN" },
            { label: "Done", value: "DONE" },
          ]}
          value={filter}
        />
        {list.loading ? (
          <SkeletonRows rows={5} />
        ) : list.error ? (
          <ErrorState message={list.error} onRetry={list.reload} />
        ) : !list.data?.items.length ? (
          <Quiet>{filter === "NEW" ? "Nothing new. Inbox zero." : "Nothing here."}</Quiet>
        ) : (
          <Rows>
            {list.data.items.map((item) => (
              <TintRow
                icon={KIND[item.kind].icon}
                key={item.id}
                onPress={() => show(item)}
                subtitle={[item.sender.name, item.role ? readableRole(item.role as Role) : null, dates.ago(item.createdAt)].filter(Boolean).join(" · ")}
                title={item.message.replace(/\s+/g, " ")}
                tone={KIND[item.kind].tone}
              />
            ))}
          </Rows>
        )}
      </View>

      <Sheet onClose={() => setOpen(null)} open={open !== null} tall title={open ? KIND[open.kind].label : ""}>
        {open ? (
          <View className="gap-4 pb-2">
            <Text className="text-base">{open.message}</Text>
            {open.screenshots.length ? (
              <Button
                icon="image"
                label={`${open.screenshots.length} attachment${open.screenshots.length === 1 ? "" : "s"}`}
                onPress={() => openAssetViewer(open.screenshots.map((shot) => ({ assetId: shot.id, title: open.sender.name })))}
                variant="outline"
              />
            ) : null}
            <View>
              <FactRow label="From" value={open.sender.name} />
              {open.role ? <FactRow label="Role" value={readableRole(open.role as Role)} /> : null}
              {open.hostel ? <FactRow label="Hostel" value={open.hostel} /> : null}
              <FactRow label="Where" value={[open.platform, open.page, open.appVersion ? `v${open.appVersion}` : null].filter(Boolean).join(" · ")} />
              <FactRow label="Sent" value={dates.date(open.createdAt)} />
            </View>
            <View className="flex-row gap-3">
              {open.sender.phone ? (
                <View className="flex-1">
                  <Button icon="call" label="Call" onPress={() => void Linking.openURL(`tel:${open.sender.phone}`)} variant="outline" />
                </View>
              ) : null}
              {open.sender.email ? (
                <View className="flex-1">
                  <Button icon="mail" label="Reply" onPress={() => void Linking.openURL(`mailto:${open.sender.email}`)} variant="outline" />
                </View>
              ) : null}
            </View>
            {open.status !== "DONE" ? (
              <Button
                icon="checkmark-circle"
                label="Mark done"
                onPress={() => {
                  void move(open, "DONE");
                  setOpen(null);
                }}
              />
            ) : (
              <Button label="Reopen" onPress={() => { void move(open, "SEEN"); setOpen(null); }} variant="outline" />
            )}
          </View>
        ) : null}
      </Sheet>
    </Screen>
  );
}
