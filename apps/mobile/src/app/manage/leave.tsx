import { router } from "expo-router";
import { useCallback, useState } from "react";
import { View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { ChoiceChips } from "@/components/ui/choice-chips";
import { Glyph } from "@/components/ui/glyph";
import { Input } from "@/components/ui/input";
import { FactRow } from "@/components/ui/layout";
import { Screen } from "@/components/ui/screen";
import { SkeletonCard } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import {
  cancelHostelLeave,
  getHostelLeave,
  type HostelLeaveOverview,
  sendHostelLeave,
} from "@/lib/admin-manage-api";
import { readApiError } from "@/lib/api-contract";
import { openConfirm } from "@/lib/confirm";
import { toastError, toastSuccess } from "@/lib/toast";
import { PLATFORM_NAME } from "@hostel/brand/brand";

/**
 * Leave the platform — the web portal's `leave` screen (docs/HOSTEL_LEAVE_PLATFORM.md).
 *
 * Owner only: the server refuses wardens. Plan bills have to be cleared before
 * the form shows; our team approves, emails the data and holds it for the days
 * picked here, during which the owner can claim the hostel back.
 */
export default function LeaveScreen() {
  const leave = useResource<HostelLeaveOverview>(getHostelLeave, { cacheKey: "admin:leave" });
  const header = <AppBar accent centerTitle showBack title={`Leave ${PLATFORM_NAME}`} />;

  if (leave.loading) {
    return (
      <Screen header={header}>
        <View className="gap-4 pt-1">
          <SkeletonCard rows={4} />
          <SkeletonCard rows={2} />
        </View>
      </Screen>
    );
  }

  if (leave.error || !leave.data) {
    return (
      <Screen header={header}>
        <ErrorState message={leave.error ?? "This page could not be loaded."} onRetry={leave.reload} />
      </Screen>
    );
  }

  return <LeaveBody data={leave.data} header={header} resource={leave} />;
}

function LeaveBody({
  data,
  header,
  resource,
}: {
  data: HostelLeaveOverview;
  header: React.ReactNode;
  resource: { refresh: () => void; refreshing: boolean };
}) {
  const { colors } = useAppTheme();
  const dates = useDates();
  const [reason, setReason] = useState("");
  const [holdDays, setHoldDays] = useState(String(data.hold.min));
  const days = Array.from({ length: data.hold.max - data.hold.min + 1 }, (_, index) => String(data.hold.min + index));

  const send = useCallback(() => {
    openConfirm({
      cancelLabel: "Keep my hostel",
      confirmLabel: "Send request",
      destructive: true,
      message: `Once we approve, ${data.hostel.name} goes off ${PLATFORM_NAME} and its portal closes. We hold your data for ${holdDays} days, then erase it.`,
      onConfirm: async () => {
        try {
          await sendHostelLeave({ holdDays: Number(holdDays), reason: reason.trim() });
          toastSuccess("Request sent", "We emailed you a copy");
          resource.refresh();
        } catch (error) {
          toastError("Could not send", readApiError(error));
        }
      },
      pin: true,
      title: `Leave ${PLATFORM_NAME}?`,
    });
  }, [data.hostel.name, holdDays, reason, resource]);

  const cancel = useCallback(() => {
    openConfirm({
      confirmLabel: "Cancel request",
      message: "Your hostel stays on as it is.",
      onConfirm: async () => {
        try {
          await cancelHostelLeave();
          toastSuccess("Request cancelled");
          resource.refresh();
        } catch (error) {
          toastError("Could not cancel", readApiError(error));
        }
      },
      title: "Cancel your request?",
    });
  }, [resource]);

  return (
    <Screen header={header} onRefresh={resource.refresh} refreshing={resource.refreshing} scroll>
      <View className="gap-5 pt-1">
        {data.request ? (
          <View>
            <SectionHeader title="Request sent" />
            <Card className="gap-3">
              <Badge label="Waiting for our team" tone="warning" />
              <FactRow label="Sent" value={dates.date(data.request.requestedAt)} />
              <FactRow label="Hold data for" value={`${data.request.holdDays} days after approval`} />
              <FactRow label="Reason" value={data.request.reason} />
              <Button label="Cancel request" onPress={cancel} variant="outline" />
            </Card>
          </View>
        ) : null}

        {!data.request && data.blockers.length > 0 ? (
          <View>
            <SectionHeader title="Clear these first" />
            <Card className="gap-3">
              {data.blockers.map((blocker) => (
                <View className="flex-row items-start gap-2" key={blocker.code}>
                  <Glyph color={colors.destructive} name="alert-circle" size={18} />
                  <Text className="flex-1" variant="body">
                    {blocker.message}
                  </Text>
                </View>
              ))}
              <Button label="Open Billing" onPress={() => router.push("/manage/billing")} />
            </Card>
          </View>
        ) : null}

        {data.canLeave ? (
          <>
            <View>
              <SectionHeader title="What happens" />
              <Card className="gap-1">
                <FactRow label="Your portal" value="Closes on approval" />
                <FactRow label="Residents and staff" value="Lose access" />
                <FactRow label="Your data" value="Emailed to you" />
                <FactRow label="Changed your mind" value="Claim it back in time" />
                <FactRow label="After the hold" value="Erased for good" />
                {data.branches.length > 0 ? (
                  <FactRow label="Branches leaving too" value={data.branches.map((branch) => branch.name).join(", ")} />
                ) : null}
              </Card>
            </View>

            <View>
              <SectionHeader title="Your request" />
              <Card className="gap-4">
                <Input
                  label="Why are you leaving?"
                  maxLength={1000}
                  multiline
                  onChangeText={setReason}
                  placeholder="Closing the hostel, moving to another app…"
                  style={{ height: 96 }}
                  value={reason}
                />
                <ChoiceChips
                  columns={5}
                  label="Hold my data for (days)"
                  onToggle={setHoldDays}
                  options={days.map((value) => ({ label: value, value }))}
                  value={holdDays}
                />
                <Button
                  disabled={reason.trim().length < 3}
                  label="Send request"
                  onPress={send}
                  variant="danger"
                />
              </Card>
            </View>
          </>
        ) : null}
      </View>
    </Screen>
  );
}

