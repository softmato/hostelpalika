import { useCallback, useState } from "react";
import { View } from "react-native";

import { Quiet, Rows, TintRow } from "@/components/platform-ui";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FactRow } from "@/components/ui/layout";
import { Screen } from "@/components/ui/screen";
import { Segmented } from "@/components/ui/segmented";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonRows } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { readableRole, type Role } from "@/constants/roles";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { readApiError } from "@/lib/api-contract";
import { openConfirm } from "@/lib/confirm";
import { type DeletionRequest, listAccountDeletions, reviewAccountDeletion } from "@/lib/platform-admin-api";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Account deletions — the owner's own call (web `platform-account-deletions-page`).
 * Approving closes the account now and erases it in 60 days; declining leaves it
 * untouched. Superadmin only on the server.
 */
export default function AccountDeletionsScreen() {
  const dates = useDates();
  const [filter, setFilter] = useState<"PENDING" | "ALL">("PENDING");
  const load = useCallback(() => listAccountDeletions(filter === "PENDING" ? "PENDING" : undefined), [filter]);
  const queue = useResource(load, { cacheKey: `platform:account-deletions:${filter}` });
  const [open, setOpen] = useState<DeletionRequest | null>(null);
  const [note, setNote] = useState("");

  function decide(request: DeletionRequest, decision: "APPROVED" | "REJECTED") {
    const run = async () => {
      try {
        await reviewAccountDeletion(request.id, decision, note);
        toastSuccess(decision === "APPROVED" ? "Approved — closed, erased in 60 days" : "Declined — the account is untouched");
        setNote("");
        queue.refresh();
      } catch (error) {
        toastError("Not recorded", readApiError(error));
      }
    };
    // The confirm host draws beneath a sheet: close it first.
    setOpen(null);
    if (decision === "REJECTED") {
      void run();
      return;
    }
    openConfirm({
      confirmLabel: "Approve deletion",
      destructive: true,
      message: "The account closes now and everything is erased in 60 days. Make sure any hostel on it has been handed over — they can still cancel from the email link.",
      onConfirm: run,
      title: `Delete ${request.requestedName ?? request.requestedEmail}?`,
    });
  }

  const requests = queue.data?.requests ?? [];

  return (
    <Screen
      header={<AppBar showBack subtitle={queue.data ? `${queue.data.pendingCount} waiting` : undefined} title="Account deletions" />}
      onRefresh={queue.refresh}
      refreshing={queue.refreshing}
      scroll
    >
      <View className="gap-4">
        <Segmented
          onChange={setFilter}
          options={[
            { count: queue.data?.pendingCount, label: "Waiting", value: "PENDING" },
            { label: "All", value: "ALL" },
          ]}
          value={filter}
        />
        {queue.loading ? (
          <SkeletonRows rows={4} />
        ) : queue.error ? (
          <ErrorState message={queue.error} onRetry={queue.reload} />
        ) : requests.length === 0 ? (
          <Quiet>No one is asking to delete their account.</Quiet>
        ) : (
          <Rows>
            {requests.map((request) => (
              <TintRow
                icon="person-remove"
                key={request.id}
                onPress={() => setOpen(request)}
                subtitle={[readableRole(request.requestedRole as Role), dates.ago(request.requestedAt)].join(" · ")}
                title={request.requestedName ?? request.requestedEmail}
                tone={request.reviewStatus === "PENDING" || !request.reviewStatus ? "danger" : "neutral"}
                value={request.reviewStatus && request.reviewStatus !== "PENDING" ? (request.reviewStatus === "APPROVED" ? "Approved" : "Declined") : undefined}
              />
            ))}
          </Rows>
        )}
      </View>

      <Sheet onClose={() => setOpen(null)} open={open !== null} title={open?.requestedName ?? open?.requestedEmail ?? ""}>
        {open ? (
          <View className="gap-4 pb-2">
            <Text className="text-base">“{open.reason}”</Text>
            <View>
              <FactRow label="Email" value={open.requestedEmail} />
              <FactRow label="Role" value={readableRole(open.requestedRole as Role)} />
              <FactRow label="Asked" value={dates.date(open.requestedAt)} />
              {open.hostelIds.length ? <FactRow label="Hostels on it" value={String(open.hostelIds.length)} /> : null}
              {open.scheduledDeletionAt ? <FactRow label="Erases" value={dates.date(open.scheduledDeletionAt)} /> : null}
              {open.reviewNote ? <FactRow label="Your note" value={open.reviewNote} /> : null}
            </View>
            {!open.reviewStatus || open.reviewStatus === "PENDING" ? (
              <>
                <Input label="Note (optional)" maxLength={1000} onChangeText={setNote} value={note} />
                <View className="flex-row gap-3">
                  <View className="flex-1">
                    <Button label="Decline" onPress={() => decide(open, "REJECTED")} variant="outline" />
                  </View>
                  <View className="flex-1">
                    <Button label="Approve" onPress={() => decide(open, "APPROVED")} variant="danger" />
                  </View>
                </View>
              </>
            ) : null}
          </View>
        ) : null}
      </Sheet>
    </Screen>
  );
}
