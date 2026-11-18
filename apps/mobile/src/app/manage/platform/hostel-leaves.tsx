import { HOSTEL_LEAVE_SECTIONS } from "@hostel/constants/hostel-leave";
import { useCallback, useState } from "react";
import { View } from "react-native";

import { Quiet, Rows, Section, TintRow } from "@/components/platform-ui";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { ChoiceChips } from "@/components/ui/choice-chips";
import { Input } from "@/components/ui/input";
import { FactRow } from "@/components/ui/layout";
import { Screen } from "@/components/ui/screen";
import { Segmented } from "@/components/ui/segmented";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonRows } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { readApiError } from "@/lib/api-contract";
import { openConfirm } from "@/lib/confirm";
import { approveHostelLeave, getHostelLeave, type HostelLeave, listHostelLeaves, rejectHostelLeave } from "@/lib/platform-admin-api";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Hostel leaves (docs/HOSTEL_LEAVE_PLATFORM.md): owners asking to take their
 * hostel off the platform. Approve emails the ticked data first, then takes the
 * hostel (and its branches) off for the hold; reject needs a reason the owner
 * reads. Superadmin only on the server.
 */

const STATUS_TEXT: Record<HostelLeave["status"], string> = {
  APPROVED: "Off the platform",
  CANCELLED: "Cancelled",
  PENDING: "Waiting",
  RECLAIMED: "Claimed back",
  REJECTED: "Not approved",
};

const ALL_SECTIONS = HOSTEL_LEAVE_SECTIONS.map((section) => section.key as string);

export default function HostelLeavesScreen() {
  const dates = useDates();
  const [filter, setFilter] = useState<"PENDING" | "APPROVED" | "ALL">("PENDING");
  const load = useCallback(() => listHostelLeaves(filter), [filter]);
  const list = useResource(load, { cacheKey: `platform:hostel-leaves:${filter}` });
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <Screen header={<AppBar showBack title="Hostel leaves" />} onRefresh={list.refresh} refreshing={list.refreshing} scroll>
      <View className="gap-4">
        <Segmented
          onChange={setFilter}
          options={[
            { label: "Waiting", value: "PENDING" },
            { label: "Approved", value: "APPROVED" },
            { label: "All", value: "ALL" },
          ]}
          value={filter}
        />
        {list.loading ? (
          <SkeletonRows rows={3} />
        ) : list.error ? (
          <ErrorState message={list.error} onRetry={list.reload} />
        ) : !list.data?.length ? (
          <Quiet>No hostel is asking to leave.</Quiet>
        ) : (
          <Rows>
            {list.data.map((request) => (
              <TintRow
                icon="log-out"
                key={request.id}
                onPress={() => setOpenId(request.id)}
                subtitle={[request.ownerName, `asked ${dates.ago(request.requestedAt)}`, request.branchCount ? `${request.branchCount} branches` : null].filter(Boolean).join(" · ")}
                title={request.hostelName}
                tone={request.status === "PENDING" ? "warning" : "neutral"}
                value={request.status === "PENDING" ? undefined : STATUS_TEXT[request.status]}
              />
            ))}
          </Rows>
        )}
      </View>

      <LeaveSheet
        id={openId}
        onClose={() => setOpenId(null)}
        onDone={() => {
          setOpenId(null);
          list.refresh();
        }}
      />
    </Screen>
  );
}

function LeaveSheet({ id, onClose, onDone }: { id: string | null; onClose: () => void; onDone: () => void }) {
  const dates = useDates();
  const load = useCallback(() => (id ? getHostelLeave(id) : Promise.resolve(null)), [id]);
  const detail = useResource(load, { cacheKey: `platform:hostel-leave:${id ?? "none"}` });
  const [sections, setSections] = useState<string[]>(ALL_SECTIONS);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const data = detail.data;
  const request = data?.request;

  function close() {
    setNote("");
    setSections(ALL_SECTIONS);
    onClose();
  }

  function approve() {
    if (!data || !request) return;
    onClose();
    openConfirm({
      confirmLabel: "Approve and email",
      destructive: true,
      message: `${sections.length} file${sections.length === 1 ? "" : "s"} go to ${request.ownerEmail ?? "the owner"} first. Then ${request.hostelName}${data.branches.length ? " and its branches" : ""} goes off the platform and is erased after ${request.holdDays} days unless the owner claims it back.`,
      onConfirm: async () => {
        try {
          await approveHostelLeave(request.id, sections, note);
          toastSuccess("Approved — data emailed, hostel off the platform");
          setNote("");
          onDone();
        } catch (error) {
          toastError("Not approved", readApiError(error));
        }
      },
      title: `Let ${request.hostelName} leave?`,
    });
  }

  async function reject() {
    if (!request) return;
    if (note.trim().length < 3) {
      toastError("Say why", "The owner reads this note.");
      return;
    }
    setBusy(true);
    try {
      await rejectHostelLeave(request.id, note);
      toastSuccess("Not approved — the owner was told");
      setNote("");
      onDone();
    } catch (error) {
      toastError("Not sent", readApiError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet onClose={close} open={id !== null} tall title={request?.hostelName ?? "Leave request"}>
      {detail.loading || !data || !request ? (
        <SkeletonRows rows={4} />
      ) : (
        <View className="gap-5 pb-2">
          <Text className="text-base">“{request.reason}”</Text>
          <View>
            <FactRow label="Owner" value={[request.ownerName, request.ownerEmail].filter(Boolean).join(" · ") || "—"} />
            <FactRow label="Asked" value={dates.date(request.requestedAt)} />
            <FactRow label="Hold" value={`${request.holdDays} days`} />
            {request.holdUntil && request.status === "APPROVED" ? <FactRow label="Erases" value={dates.date(request.holdUntil)} /> : null}
            {data.branches.length ? <FactRow label="Branches" value={data.branches.map((branch) => branch.name).join(", ")} /> : null}
            {request.exportSentTo ? <FactRow label="Data sent to" value={request.exportSentTo} /> : null}
            {request.reviewNote ? <FactRow label="Note" value={request.reviewNote} /> : null}
          </View>

          {request.status === "PENDING" ? (
            <>
              {data.blockers.length ? (
                <Section title="Cannot approve yet">
                  {data.blockers.map((blocker) => (
                    <Text className="py-1 text-sm text-destructive" key={blocker.code}>
                      {blocker.message}
                    </Text>
                  ))}
                </Section>
              ) : (
                <Section
                  action={
                    <Button
                      label={sections.length ? "Untick all" : "Tick all"}
                      onPress={() => setSections(sections.length ? [] : ALL_SECTIONS)}
                      size="sm"
                      variant="ghost"
                    />
                  }
                  title="Email the owner"
                >
                  <ChoiceChips
                    columns={2}
                    onToggle={(key) => setSections((current) => (current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key]))}
                    options={HOSTEL_LEAVE_SECTIONS.map((section) => ({ label: section.label, value: section.key as string }))}
                    value={sections}
                  />
                </Section>
              )}
              <Input label="Note (needed to refuse)" maxLength={1000} multiline onChangeText={setNote} value={note} />
              <View className="flex-row gap-3">
                <View className="flex-1">
                  <Button disabled={busy} label="Refuse" loading={busy} onPress={() => void reject()} variant="outline" />
                </View>
                <View className="flex-1">
                  <Button disabled={busy || data.blockers.length > 0} label="Approve" onPress={approve} variant="danger" />
                </View>
              </View>
            </>
          ) : null}
        </View>
      )}
    </Sheet>
  );
}
