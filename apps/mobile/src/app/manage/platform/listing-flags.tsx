import { router } from "expo-router";
import { useState } from "react";
import { View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Chip } from "@/components/ui/layout";
import { Screen } from "@/components/ui/screen";
import { Segmented } from "@/components/ui/segmented";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonRows } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { readApiError } from "@/lib/api-contract";
import { type ListingFlag, listListingFlags, resolveListingFlag, statusLabel } from "@/lib/platform-admin-api";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Hostels › Abuse Flags (web `platform-listing-flags-page`): duplicate and
 * ghost-listing reports from users and the automatic duplicate check. A flag
 * opens its hostel (and any it matched); Resolve or Dismiss needs a note for
 * the audit row.
 */

type Status = ListingFlag["status"];

const loaders: Record<Status, () => Promise<ListingFlag[]>> = {
  DISMISSED: () => listListingFlags("DISMISSED"),
  OPEN: () => listListingFlags("OPEN"),
  RESOLVED: () => listListingFlags("RESOLVED"),
};

const riskTone = (risk: ListingFlag["riskLevel"]) => (risk === "HIGH" ? "danger" : risk === "MEDIUM" ? "warning" : "neutral");

export default function ListingFlagsScreen() {
  const dates = useDates();
  const [status, setStatus] = useState<Status>("OPEN");
  const flags = useResource(loaders[status], { cacheKey: `platform:listing-flags:${status}` });
  const [deciding, setDeciding] = useState<{ flag: ListingFlag; verdict: "DISMISSED" | "RESOLVED" } | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function decide() {
    if (!deciding) return;
    setBusy(true);
    try {
      await resolveListingFlag(deciding.flag.id, deciding.verdict, note);
      toastSuccess(deciding.verdict === "RESOLVED" ? "Flag resolved" : "Flag dismissed");
      setDeciding(null);
      flags.refresh();
    } catch (error) {
      toastError("Not saved", readApiError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen header={<AppBar showBack subtitle="Duplicate and ghost listings" title="Abuse flags" />} onRefresh={flags.refresh} refreshing={flags.refreshing} scroll>
      <View className="gap-4">
        <Segmented
          onChange={setStatus}
          options={[
            { count: status === "OPEN" ? flags.data?.length : undefined, label: "Open", value: "OPEN" },
            { label: "Resolved", value: "RESOLVED" },
            { label: "Dismissed", value: "DISMISSED" },
          ]}
          value={status}
        />

        {flags.loading ? (
          <SkeletonRows rows={4} />
        ) : flags.error || !flags.data ? (
          <ErrorState message={flags.error ?? "Flags could not be loaded."} onRetry={flags.reload} />
        ) : flags.data.length === 0 ? (
          <EmptyCard description={status === "OPEN" ? "No listing is flagged." : "Nothing here yet."} title="All clear" />
        ) : (
          <View className="gap-3">
            {flags.data.map((flag) => (
              <Card className="gap-3" key={flag.id}>
                <View className="flex-row items-center gap-2">
                  <Badge label={`${statusLabel(flag.riskLevel)} risk`} tone={riskTone(flag.riskLevel)} />
                  {flag.createdAt ? (
                    <Text className="ml-auto text-xs" variant="muted">
                      {dates.ago(flag.createdAt)}
                    </Text>
                  ) : null}
                </View>
                <Text>{flag.reason}</Text>
                {flag.signals.length ? (
                  <View className="flex-row flex-wrap gap-2">
                    {flag.signals.map((signal) => (
                      <Badge key={signal} label={statusLabel(signal)} tone="neutral" />
                    ))}
                  </View>
                ) : null}
                <View className="flex-row flex-wrap gap-2">
                  <Chip icon="hostel" label="Flagged hostel" onPress={() => router.push(`/manage/platform/hostel/${flag.hostelId}`)} tone="brand" />
                  {flag.matchedHostelIds.map((id, index) => (
                    <Chip icon="duplicate" key={id} label={`Match ${index + 1}`} onPress={() => router.push(`/manage/platform/hostel/${id}`)} />
                  ))}
                </View>
                {flag.status === "OPEN" ? (
                  <View className="flex-row gap-3">
                    <View className="flex-1">
                      <Button label="Dismiss" onPress={() => (setNote(""), setDeciding({ flag, verdict: "DISMISSED" }))} size="sm" variant="outline" />
                    </View>
                    <View className="flex-1">
                      <Button label="Resolve" onPress={() => (setNote(""), setDeciding({ flag, verdict: "RESOLVED" }))} size="sm" />
                    </View>
                  </View>
                ) : flag.resolutionNote ? (
                  <Text className="text-sm" variant="muted">
                    {flag.resolutionNote}
                  </Text>
                ) : null}
              </Card>
            ))}
          </View>
        )}
      </View>

      <Sheet
        footer={
          <Button
            disabled={busy || note.trim().length < 2}
            label={deciding?.verdict === "RESOLVED" ? "Resolve" : "Dismiss"}
            loading={busy}
            onPress={() => void decide()}
          />
        }
        onClose={() => setDeciding(null)}
        open={deciding !== null}
        title={deciding?.verdict === "RESOLVED" ? "Resolve this flag" : "Dismiss this flag"}
      >
        <View className="gap-3">
          <Text variant="muted">
            {deciding?.verdict === "RESOLVED"
              ? "Say what you did — archived the copy, merged, asked the owner."
              : "Say why it is not a problem — different branch, same owner, false match."}
          </Text>
          <Input label="Note" maxLength={800} multiline onChangeText={setNote} value={note} />
        </View>
      </Sheet>
    </Screen>
  );
}
