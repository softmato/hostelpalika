import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Linking, View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Chip, FactRow } from "@/components/ui/layout";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonCard } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { readApiError } from "@/lib/api-contract";
import { openAssetViewer } from "@/lib/asset-viewer";
import { openConfirm } from "@/lib/confirm";
import { formatMoney } from "@/lib/format";
import {
  getPlatformHostel,
  getPlatformHostelBilling,
  type HostelAction,
  hostelActions,
  hostelStatusTone,
  liftHostelSuspension,
  runHostelAction,
  statusLabel,
  suspendHostel,
} from "@/lib/platform-admin-api";
import { invalidateQuery } from "@/lib/query-cache";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * One hostel, as the web's review page has it: stage and plan at the top, the
 * moves valid for its stage (web `actionsForHostel`) plus Suspend, then the
 * owner, the KYC papers (tap to open), and the facts.
 */

/** Web `REQUIRED_DOCUMENTS`. */
const DOCUMENTS = ["Ownership proof", "Hostel registration / licence", "Owner citizenship", "Tax / PAN certificate"];

const ACTIONS: Record<HostelAction, { label: string; past: string; reason?: string; variant: "danger" | "outline" | "primary" }> = {
  approve: { label: "Approve", past: "Approved", variant: "primary" },
  archive: { label: "Archive", past: "Archived", reason: "Why it leaves the site. Erased after 60 days.", variant: "danger" },
  publish: { label: "Publish", past: "Published", variant: "primary" },
  reject: { label: "Reject", past: "Rejected", reason: "The owner reads this in their email.", variant: "outline" },
  "request-documents": { label: "Ask for papers", past: "Papers asked for", variant: "outline" },
  restore: { label: "Restore", past: "Restored", variant: "primary" },
  unpublish: { label: "Unpublish", past: "Unpublished", reason: "The owner reads this in their email.", variant: "outline" },
};

export default function PlatformHostelScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const dates = useDates();
  const detail = useResource(() => getPlatformHostel(id), { cacheKey: `platform:hostel:${id}` });
  const billing = useResource(() => getPlatformHostelBilling(id), { cacheKey: `platform:hostel:${id}:billing` });
  const [reasonFor, setReasonFor] = useState<HostelAction | null>(null);
  const [reason, setReason] = useState("");
  const [asking, setAsking] = useState(false);
  const [asked, setAsked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const data = detail.data;
  const hostel = data?.hostel;

  const done = (message: string) => {
    toastSuccess(message);
    invalidateQuery("platform:hostels");
    invalidateQuery("platform:hostels:archived");
    invalidateQuery("platform:dashboard");
    detail.refresh();
    billing.refresh();
  };

  async function run(action: HostelAction, body?: Record<string, unknown>) {
    setBusy(true);
    try {
      await runHostelAction(id, action, body);
      setReasonFor(null);
      setAsking(false);
      done(ACTIONS[action].past);
    } catch (error) {
      toastError(`${ACTIONS[action].label} failed`, readApiError(error));
    } finally {
      setBusy(false);
    }
  }

  function start(action: HostelAction) {
    if (action === "request-documents") {
      setAsked([]);
      setReason("");
      setAsking(true);
    } else if (ACTIONS[action].reason) {
      setReason("");
      setReasonFor(action);
    } else {
      openConfirm({
        confirmLabel: ACTIONS[action].label,
        message:
          action === "approve"
            ? "The owner is told by email. A public hostel gets its portal once the plan is paid."
            : action === "publish"
              ? "It shows in public search from now."
              : "It comes back to the queue as it was.",
        onConfirm: () => run(action),
        title: `${ACTIONS[action].label} ${hostel?.name ?? "this hostel"}?`,
      });
    }
  }

  function toggleSuspension() {
    if (!hostel) return;
    const lifting = Boolean(hostel.suspension);
    openConfirm({
      confirmLabel: lifting ? "Lift it" : "Suspend",
      destructive: !lifting,
      message: lifting
        ? "Every portal of this hostel opens again now."
        : "The owner gets 3 days' notice and the plan invoice, then every portal of this hostel is blocked until the plan is paid.",
      onConfirm: async () => {
        try {
          await (lifting ? liftHostelSuspension(id) : suspendHostel(id));
          done(lifting ? "Suspension lifted" : "Suspension started");
        } catch (error) {
          toastError(lifting ? "Not lifted" : "Not suspended", readApiError(error));
        }
      },
      title: lifting ? "Lift the suspension?" : `Suspend ${hostel.name}?`,
    });
  }

  const header = <AppBar showBack subtitle={hostel?.location.area} title={hostel?.name ?? "Hostel"} />;

  if (detail.loading) {
    return (
      <Screen header={header} scroll>
        <View className="gap-4">
          <SkeletonCard rows={3} />
          <SkeletonCard rows={5} />
        </View>
      </Screen>
    );
  }

  if (detail.error || !data || !hostel) {
    return (
      <Screen header={header}>
        <ErrorState message={detail.error ?? "This hostel could not be loaded."} onRetry={detail.reload} />
      </Screen>
    );
  }

  const plan = billing.data?.plan;
  const actions = hostelActions(hostel);
  const owner = data.owner ?? data.applicant;
  const application = data.application;

  return (
    <Screen header={header} onRefresh={detail.refresh} refreshing={detail.refreshing} scroll>
      <View className="gap-5">
        <Card className="gap-3">
          <View className="flex-row flex-wrap gap-2">
            <Badge label={statusLabel(hostel.status)} tone={hostelStatusTone(hostel.status)} />
            <Badge
              label={`KYC ${statusLabel(hostel.kyc?.status ?? hostel.verificationStatus)}`}
              tone={hostel.verificationStatus === "VERIFIED" || hostel.kyc?.status === "APPROVED" ? "success" : "warning"}
            />
            {hostel.isArchived ? <Badge label="Archived" tone="neutral" /> : null}
            {hostel.isDemoData ? <Badge label="Demo" tone="neutral" /> : null}
          </View>
          {hostel.suspension ? (
            <View className="rounded-xl bg-destructive-soft px-3 py-2">
              <Text className="text-sm text-destructive">
                {hostel.suspension.stage === "SUSPENDED"
                  ? `Suspended since ${dates.date(hostel.suspension.graceEndsAt)} — unpaid plan.`
                  : `Notice running — blocked on ${dates.dateTime(hostel.suspension.graceEndsAt)} unless the plan is paid.`}
              </Text>
            </View>
          ) : null}
          {hostel.isArchived ? (
            <Text variant="muted">
              {[hostel.archiveReason, hostel.purgeScheduledAt ? `Erased on ${dates.date(hostel.purgeScheduledAt)}` : null].filter(Boolean).join(" · ")}
            </Text>
          ) : null}
          {application?.rejectionReason ? <FactRow label="Rejected for" value={application.rejectionReason} /> : null}
          {application?.infoRequestNote ? <FactRow label="Asked for" value={application.infoRequestNote} /> : null}

          <View className="flex-row flex-wrap gap-2 pt-1">
            {actions.map((action) => (
              <View className="min-w-[46%] flex-1" key={action}>
                <Button disabled={busy} label={ACTIONS[action].label} onPress={() => start(action)} size="sm" variant={ACTIONS[action].variant} />
              </View>
            ))}
            {!hostel.isArchived ? (
              <View className="min-w-[46%] flex-1">
                <Button
                  disabled={busy}
                  label={hostel.suspension ? "Lift suspension" : "Suspend"}
                  onPress={toggleSuspension}
                  size="sm"
                  variant={hostel.suspension ? "primary" : "outline"}
                />
              </View>
            ) : null}
          </View>
        </Card>

        <View>
          <SectionHeader title="Plan" />
          <Card>
            {billing.loading ? (
              <SkeletonCard rows={2} />
            ) : plan ? (
              <>
                <FactRow label="Plan" value={[plan.planName, plan.cycleLabel].filter(Boolean).join(" · ") || "—"} />
                {plan.status ? <FactRow label="Status" value={statusLabel(plan.status)} /> : null}
                <FactRow label="Paid" value={formatMoney(plan.amountPaid)} />
                <FactRow label="Due" value={plan.amountDue > 0 ? formatMoney(plan.amountDue) : "Nothing due"} />
              </>
            ) : (
              <Text variant="muted">{billing.error ?? "No plan chosen yet."}</Text>
            )}
          </Card>
        </View>

        {owner ? (
          <View>
            <SectionHeader title={data.owner ? "Owner" : "Applicant"} />
            <Card padding="px-4 py-1">
              <ListRow icon="person" subtitle={owner.registeredAt ? `Joined ${dates.date(owner.registeredAt)}` : undefined} title={owner.name || "—"} />
              {owner.phone ? (
                <>
                  <RowDivider />
                  <ListRow icon="call" onPress={() => void Linking.openURL(`tel:${owner.phone}`)} title={owner.phone} />
                </>
              ) : null}
              {owner.email ? (
                <>
                  <RowDivider />
                  <ListRow icon="mail" onPress={() => void Linking.openURL(`mailto:${owner.email}`)} title={owner.email} />
                </>
              ) : null}
            </Card>
          </View>
        ) : null}

        <View>
          <SectionHeader title={`Papers · ${data.documents.length}`} />
          {data.documents.length === 0 ? (
            <Card>
              <Text variant="muted">No papers uploaded.</Text>
            </Card>
          ) : (
            <Card padding="px-4 py-1">
              {data.documents.map((doc, index) => (
                <View key={doc.id}>
                  {index > 0 ? <RowDivider /> : null}
                  <ListRow
                    icon="document-text"
                    onPress={() =>
                      openAssetViewer(
                        data.documents.map((item) =>
                          item.fileAssetId ? { assetId: item.fileAssetId, title: item.documentType } : { title: item.documentType, url: item.fileUrl },
                        ),
                        index,
                      )
                    }
                    right={<Badge label={statusLabel(doc.status)} tone={doc.status === "APPROVED" ? "success" : doc.status === "REJECTED" ? "danger" : "warning"} />}
                    subtitle={doc.rejectionReason || (doc.createdAt ? dates.date(doc.createdAt) : undefined)}
                    title={doc.documentType}
                  />
                </View>
              ))}
            </Card>
          )}
        </View>

        <View>
          <SectionHeader title="Hostel" />
          <Card>
            {hostel.hostelCode ? <FactRow label="Code" value={hostel.hostelCode} /> : null}
            <FactRow label="Type" value={statusLabel(hostel.hostelType)} />
            <FactRow label="Address" value={[hostel.location.address, hostel.location.area, hostel.location.city].filter(Boolean).join(", ") || "—"} />
            {hostel.capacitySummary?.totalBeds ? (
              <FactRow label="Beds" value={`${hostel.capacitySummary.totalBeds} · ${hostel.capacitySummary.vacantBeds ?? 0} free`} />
            ) : null}
            {hostel.pricing?.monthlyRentMin ? (
              <FactRow label="Rent" value={`${formatMoney(hostel.pricing.monthlyRentMin)} – ${formatMoney(hostel.pricing.monthlyRentMax ?? hostel.pricing.monthlyRentMin)}`} />
            ) : null}
            {hostel.panNumber ? <FactRow label="PAN / VAT" value={hostel.panNumber} /> : null}
            {hostel.branchOf ? <FactRow label="Branch of" value={hostel.branchOf.name} /> : null}
            {application?.submittedAt ? <FactRow label="Submitted" value={dates.date(application.submittedAt)} /> : null}
            {hostel.createdAt ? <FactRow label="Registered" value={dates.date(hostel.createdAt)} /> : null}
          </Card>
        </View>

        {hostel.portals?.length ? (
          <View>
            <SectionHeader title="Logins" />
            <Card>
              {hostel.portals.map((portal) => (
                <FactRow
                  key={portal.role}
                  label={statusLabel(portal.role)}
                  value={portal.accounts === 0 ? "No login" : `${portal.opened}/${portal.accounts} opened`}
                />
              ))}
            </Card>
          </View>
        ) : null}

        {hostel.status === "PUBLISHED" ? (
          <Button icon="open" label="See the public page" onPress={() => router.push(`/hostel/${hostel.slug}` as never)} variant="ghost" />
        ) : null}
      </View>

      <Sheet
        footer={
          <Button
            disabled={busy || reason.trim().length < 3}
            label={reasonFor ? ACTIONS[reasonFor].label : "Save"}
            loading={busy}
            onPress={() => reasonFor && void run(reasonFor, { reason: reason.trim() })}
            variant={reasonFor === "archive" ? "danger" : "primary"}
          />
        }
        onClose={() => setReasonFor(null)}
        open={reasonFor !== null}
        title={reasonFor ? `${ACTIONS[reasonFor].label} ${hostel.name}` : ""}
      >
        <View className="gap-3">
          <Text variant="muted">{reasonFor ? ACTIONS[reasonFor].reason : ""}</Text>
          <Input label="Reason" maxLength={1000} multiline onChangeText={setReason} placeholder="At least 3 letters" value={reason} />
        </View>
      </Sheet>

      <Sheet
        footer={
          <Button
            disabled={busy || asked.length === 0}
            label={`Ask for ${asked.length || ""} ${asked.length === 1 ? "paper" : "papers"}`.replace("  ", " ")}
            loading={busy}
            onPress={() =>
              void run("request-documents", {
                documents: asked.map((documentType) => ({ documentType })),
                note: reason.trim() || undefined,
              })
            }
          />
        }
        onClose={() => setAsking(false)}
        open={asking}
        title="Ask for papers"
      >
        <View className="gap-4">
          <View className="flex-row flex-wrap gap-2">
            {DOCUMENTS.map((name) => (
              <Chip
                key={name}
                label={name}
                onPress={() => setAsked((current) => (current.includes(name) ? current.filter((item) => item !== name) : [...current, name]))}
                tone={asked.includes(name) ? "brand" : "neutral"}
              />
            ))}
          </View>
          <Input label="Note to the owner" maxLength={1000} multiline onChangeText={setReason} placeholder="Optional" value={reason} />
        </View>
      </Sheet>
    </Screen>
  );
}
