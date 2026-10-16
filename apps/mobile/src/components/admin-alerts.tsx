import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { Linking, View } from "react-native";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Glyph, type GlyphName } from "@/components/ui/glyph";
import { Input } from "@/components/ui/input";
import { Chip } from "@/components/ui/layout";
import { ListRow } from "@/components/ui/list-row";
import { Money } from "@/components/ui/money";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import {
  acknowledgeSos,
  type AdminAlerts,
  type AdminClaim,
  type AdminInquiry,
  approveClaim,
  rejectClaim,
  replyToComplaint,
} from "@/lib/admin-api";
import type { AlertKind, AlertRow } from "@/lib/admin-alerts";
import { adminQuery } from "@/lib/admin-queries";
import {
  addInquiryNote,
  INQUIRY_STATUSES,
  type InquiryStatus,
  setInquiryStatus,
} from "@/lib/admin-manage-api";
import { readApiError } from "@/lib/api-contract";
import { openAssetViewer } from "@/lib/asset-viewer";
import { formatMoney, humanizeEnum } from "@/lib/format";
import { dayInputFromNow, startOfDayIso } from "@/lib/manage-dates";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * One-tap rejection reasons — the same sentences the web review queue offers
 * (`CLAIM_REJECTION_REASONS` on the server, minus `OTHER`, which is the text
 * box). A tap fills the box, so the admin can still edit it before sending.
 */
const QUICK_REJECT_REASONS = [
  "The amount does not match this invoice.",
  "We have not received this payment yet.",
  "The screenshot is unreadable — please send a clearer one.",
  "This payment has already been recorded.",
  "The payment went to an account we do not use.",
  "This payment belongs to a different month.",
];

/**
 * The four unprompted things, fetched **once for the whole admin group**.
 *
 * ## Why this is a provider and not four screen-level fetches
 *
 * The tabs moved from `Overview / Alerts / Residents / More` to the five that
 * mirror the portal's own groups, and that split one inbox across four
 * destinations: claims to Money, complaints to Today, inquiries to Residents,
 * SOS to a banner on Home. Four screens each calling `getAdminAlerts()` would be
 * sixteen requests for the same four lists, and — worse — a tab badge would only
 * be right on the tab you were already looking at.
 *
 * So the admin layout fetches once, holds it here, and every screen reads its
 * own slice. One `refresh` is shared: approving a claim on Money moves the badge
 * on Home in the same tick, because there is only one copy of the data.
 *
 * `useResource`'s `topics` keep it live — the socket publishes `payments`,
 * `complaints`, `inquiries` and `safety` on every server-side change, so an SOS
 * raised while the app is open lands on the banner without a pull.
 *
 * ## And once per *session*, not once per visit
 *
 * The provider unmounts when a warden leaves the group — to the public browse
 * tabs, to a hostel page, to settings — so "once for the whole admin group" used
 * to end at the group's edge, and every return counted the badges again from
 * nothing. The queue is now keyed in `lib/query-cache`, so coming back paints
 * the counts it left with and revalidates behind them.
 */
type AdminAlertsValue = {
  /** How many rows of each kind need someone. Drives the tab badges. */
  counts: Record<AlertKind, number>;
  data: AdminAlerts | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
  refreshing: boolean;
  reload: () => void;
};

const EMPTY_COUNTS: Record<AlertKind, number> = {
  claim: 0,
  complaint: 0,
  inquiry: 0,
  sos: 0,
};

const AdminAlertsContext = createContext<AdminAlertsValue | null>(null);

export function AdminAlertsProvider({ children }: { children: ReactNode }) {
  const query = adminQuery.alerts();
  const alerts = useResource<AdminAlerts>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  const { data, error, loading, refresh, refreshing, reload } = alerts;

  const value = useMemo<AdminAlertsValue>(
    () => ({
      counts: data
        ? {
            claim: data.claims.length,
            complaint: data.complaints.length,
            inquiry: data.inquiries.length,
            sos: data.sos.length,
          }
        : EMPTY_COUNTS,
      data,
      error,
      loading,
      refresh,
      refreshing,
      reload,
    }),
    [data, error, loading, refresh, refreshing, reload],
  );

  return (
    <AdminAlertsContext.Provider value={value}>{children}</AdminAlertsContext.Provider>
  );
}

/**
 * Reads the shared queue.
 *
 * Falls back to an empty, never-loading value outside the provider rather than
 * throwing: the only caller that could be outside it is a route reached by a
 * push deep link before the group's layout has mounted, and an admin screen that
 * crashes on a notification tap is a worse failure than one whose queue section
 * is briefly empty.
 */
export function useAdminAlerts(): AdminAlertsValue {
  const value = useContext(AdminAlertsContext);

  return (
    value ?? {
      counts: EMPTY_COUNTS,
      data: null,
      error: null,
      loading: false,
      refresh: () => {},
      refreshing: false,
      reload: () => {},
    }
  );
}

/**
 * Names which sources the account's capabilities refused.
 *
 * A warden may hold `viewComplaints` and not `viewPayments`, in which case the
 * claims queue 403s while everything else returns. Rendered wherever a queue is
 * shown, because an empty list standing in for a denial is the exact lie the
 * guardian screens exist to avoid.
 */
export function DeniedNotice({ denied }: { denied: string[] }) {
  if (denied.length === 0) {
    return null;
  }

  return (
    <Card className="gap-1">
      <Text variant="label">Some of this is not yours to see</Text>
      <Text variant="muted">
        {`Your account does not have permission for ${denied.join(
          ", ",
        )}. Ask your hostel admin if that looks wrong.`}
      </Text>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* The three decisions                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Approve or reject a claim, reply to a complaint, acknowledge an SOS — and the
 * sheet the two text-taking ones need.
 *
 * Lifted out of the old Alerts screen unchanged in behaviour, because these are
 * the decisions that are worse for waiting and that a person can make from a
 * phone with the facts already on screen. Resolving an SOS, changing a
 * complaint's status or converting an inquiry each need context a phone does not
 * have, so each still opens the web portal from More.
 *
 * The caller renders `sheet` once, as a sibling of its `<Screen>`.
 */
export function useAlertActions() {
  const { refresh } = useAdminAlerts();
  const [pending, setPending] = useState<{
    mode: "reject" | "reply";
    row: AlertRow;
  } | null>(null);
  const [note, setNote] = useState("");
  /** The id currently in flight — disables just that row, not the whole list. */
  const [busyId, setBusyId] = useState<string | null>(null);

  /** Resolves to whether the server took it, so a caller can close on success. */
  const run = useCallback(
    async (id: string, action: () => Promise<void>, success: string) => {
      setBusyId(id);

      try {
        await action();
        toastSuccess(success);
        // The row is gone from the server's queue now; refetch rather than
        // splicing it out locally, because approving a claim also moves the
        // invoice and the dashboard's counters.
        refresh();

        return true;
      } catch (caught) {
        toastError("That didn't go through", readApiError(caught));

        return false;
      } finally {
        setBusyId(null);
      }
    },
    [refresh],
  );

  const submitNote = useCallback(async () => {
    if (!pending) {
      return;
    }

    const { mode, row } = pending;
    const text = note.trim();

    // The server's own bounds: a rejection reason is 3–500 characters and a
    // complaint reply 2–2000. Checked here so the sheet does not close on a
    // round trip that was always going to 422.
    if (mode === "reject" ? text.length < 3 : text.length < 2) {
      toastError(
        mode === "reject" ? "Give a reason" : "Write a reply",
        mode === "reject"
          ? "The resident is shown this, so it has to say something."
          : "The resident is shown this.",
      );
      return;
    }

    /*
     * The sheet stays up until the server answers.
     *
     * It used to close on the tap and send the request behind it, which left the
     * card underneath as the only place the work was reported — and a rejection
     * that failed came back as a toast over a sheet that had already thrown the
     * typed reason away. Closing on the answer means the button carries the
     * wait, and a 422 leaves the words where they were typed.
     */
    const ok = await run(
      row.id,
      () => (mode === "reject" ? rejectClaim(row.id, text) : replyToComplaint(row.id, text)),
      mode === "reject" ? "Claim rejected" : "Reply sent",
    );

    if (ok) {
      setPending(null);
      setNote("");
    }
  }, [note, pending, run]);

  const ask = useCallback((mode: "reject" | "reply", row: AlertRow) => {
    setNote("");
    setPending({ mode, row });
  }, []);

  /* ---------------------------------------------------------------------- */
  /* Following up an inquiry                                                */
  /* ---------------------------------------------------------------------- */

  /*
   * This used to live on the Residents tab, in a tinted block above the roster,
   * and the card here said to go and do it in the web portal instead. Both were
   * wrong the same way: a lead is a decision waiting, which is what this screen
   * is, and "open the browser" is not an answer on a phone standing in a hostel.
   *
   * It keeps its own state rather than joining `pending`: the other two modes
   * are one text box, and this is a status, a note and a date.
   */
  const [lead, setLead] = useState<AdminInquiry | null>(null);
  const [leadStatus, setLeadStatus] = useState<InquiryStatus>("CONTACTED");
  const [leadNote, setLeadNote] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [savingLead, setSavingLead] = useState(false);

  const askInquiry = useCallback((inquiry: AdminInquiry) => {
    setLead(inquiry);
    setLeadStatus("CONTACTED");
    setLeadNote("");
    setFollowUp("");
  }, []);

  const saveLead = useCallback(async () => {
    if (!lead) {
      return;
    }

    if (followUp && !startOfDayIso(followUp)) {
      toastError("Check the follow-up date", "Write it as YYYY-MM-DD.");
      return;
    }

    setSavingLead(true);

    try {
      await setInquiryStatus(lead.id, leadStatus);

      // The note is optional and goes second: a status change that succeeded
      // should not be undone by an empty note, and the two are separate routes.
      if (leadNote.trim()) {
        await addInquiryNote(lead.id, {
          nextFollowUpAt: followUp ? (startOfDayIso(followUp) ?? undefined) : undefined,
          note: leadNote.trim(),
        });
      }

      toastSuccess(`Marked ${humanizeEnum(leadStatus).toLowerCase()}`);
      setLead(null);
      refresh();
    } catch (caught) {
      toastError("Could not save", readApiError(caught));
    } finally {
      setSavingLead(false);
    }
  }, [followUp, lead, leadNote, leadStatus, refresh]);

  const noteSheet = (
    <Sheet
      footer={
        <Button
          label={pending?.mode === "reject" ? "Reject claim" : "Send reply"}
          loading={pending !== null && busyId === pending.row.id}
          onPress={() => void submitNote()}
        />
      }
      onClose={() => setPending(null)}
      open={Boolean(pending)}
      title={pending?.mode === "reject" ? "Why are you rejecting this?" : "Reply"}
    >
      <View className="gap-3">
        <Text variant="muted">
          {pending?.mode === "reject"
            ? "The resident is shown this reason, so it should tell them what to do next."
            : "The resident is shown this reply on their complaint."}
        </Text>
        {pending?.mode === "reject" ? (
          <View className="flex-row flex-wrap gap-2">
            {QUICK_REJECT_REASONS.map((reason) => (
              <Chip
                key={reason}
                label={reason}
                onPress={() => setNote(reason)}
                tone={note === reason ? "brand" : "neutral"}
              />
            ))}
          </View>
        ) : null}
        <Input
          // Reject leads with the one-tap reasons; a keyboard up on open would
          // cover them.
          autoFocus={pending?.mode !== "reject"}
          maxLength={pending?.mode === "reject" ? 500 : 2000}
          multiline
          numberOfLines={4}
          onChangeText={setNote}
          placeholder={
            pending?.mode === "reject"
              ? "e.g. The screenshot shows a different amount"
              : "e.g. A plumber is coming tomorrow morning"
          }
          value={note}
        />
      </View>
    </Sheet>
  );

  const leadSheet = (
    <Sheet
      footer={
        <Button label="Save" loading={savingLead} onPress={() => void saveLead()} />
      }
      onClose={() => setLead(null)}
      open={lead !== null}
      title={lead?.name || "Inquiry"}
    >
      {lead ? (
        <View className="gap-3 pb-2">
          {lead.message ? <Text variant="muted">{lead.message}</Text> : null}

          {lead.phone ? (
            <Button
              label={`Call ${lead.phone}`}
              onPress={() => void Linking.openURL(`tel:${lead.phone}`)}
              variant="outline"
            />
          ) : null}

          <Select
            label="Where this got to"
            onChange={setLeadStatus}
            options={INQUIRY_STATUSES.map((value) => ({
              label: humanizeEnum(value),
              value,
            }))}
            value={leadStatus}
          />

          {leadStatus === "CONVERTED" ? (
            <Text variant="caption">
              Converted records that they took a bed. It does not register them — that
              is Register a resident on the Residents tab, and an inquiry marked
              converted with nobody registered is a state nothing else will notice.
            </Text>
          ) : null}

          <Input
            label="Note"
            multiline
            onChangeText={setLeadNote}
            placeholder="Called, visiting Saturday morning"
            style={{ height: 80 }}
            value={leadNote}
          />

          <Input
            hint="Optional. It is what turns “call them back” into something the hostel is reminded of."
            keyboardType="numbers-and-punctuation"
            label="Ring back on"
            onChangeText={setFollowUp}
            placeholder="YYYY-MM-DD"
            value={followUp}
          />

          <View className="flex-row flex-wrap gap-2">
            <Button
              label="Tomorrow"
              onPress={() => setFollowUp(dayInputFromNow(1))}
              size="sm"
              variant="outline"
            />
            <Button
              label="In 3 days"
              onPress={() => setFollowUp(dayInputFromNow(3))}
              size="sm"
              variant="outline"
            />
          </View>
        </View>
      ) : null}
    </Sheet>
  );

  /*
   * Both sheets, as one node. The caller renders it once beside its `<Screen>`;
   * only one of the two can be open, because opening either is a tap on a card
   * that the other one's backdrop is covering.
   */
  const sheet = (
    <>
      {noteSheet}
      {leadSheet}
    </>
  );

  return { ask, askInquiry, busyId, run, sheet };
}

export type AlertActions = ReturnType<typeof useAlertActions>;

/* -------------------------------------------------------------------------- */
/* One row                                                                    */
/* -------------------------------------------------------------------------- */

const ICONS: Record<AlertKind, GlyphName> = {
  claim: "card",
  complaint: "chatbox-ellipses",
  inquiry: "mail",
  sos: "alert-circle",
};

const TONES: Record<AlertKind, "danger" | "info" | "neutral" | "warning"> = {
  claim: "warning",
  complaint: "warning",
  inquiry: "info",
  sos: "danger",
};

const LABELS: Record<AlertKind, string> = {
  claim: "Payment claim",
  complaint: "Overdue complaint",
  inquiry: "Inquiry",
  sos: "SOS",
};

/**
 * One queue row with the buttons its kind earns.
 *
 * The kind badge is off by default now that each queue lives on the tab that
 * owns it — a card under a "Payment claims" heading does not need to say
 * "Payment claim" again. The combined queue passes `showKind` to get it back,
 * because there the label is the only thing telling four sources apart.
 */
export function AlertCard({
  actions,
  claim,
  inquiry,
  row,
  showKind = false,
}: {
  actions: AlertActions;
  claim?: AdminClaim;
  /** The lead behind an `inquiry` row — its message, phone and status live here. */
  inquiry?: AdminInquiry;
  row: AlertRow;
  showKind?: boolean;
}) {
  const { colors } = useAppTheme();
  const dates = useDates();
  const busy = actions.busyId === row.id;

  return (
    <Card className="gap-3">
      <ListRow
        icon={ICONS[row.kind]}
        right={
          showKind ? <Badge label={LABELS[row.kind]} tone={TONES[row.kind]} /> : undefined
        }
        subtitle={row.subtitle}
        title={row.title}
      />

      <View className="flex-row items-center justify-between gap-2 border-t border-border pt-3">
        <Text variant="caption">{row.at ? dates.relativeDay(row.at) : "Undated"}</Text>

        {claim ? (
          <View className="flex-row items-center gap-2">
            <Money value={claim.amount} />
            {/*
              `allGreen` is the server's own verdict across every claim check —
              the same rule the web's "Approve all" gate applies. Surfacing it
              means an admin approving from a phone is not approving blind.
            */}
            <Badge
              label={claim.allGreen ? "Checks pass" : "Needs a look"}
              tone={claim.allGreen ? "success" : "warning"}
            />
          </View>
        ) : null}
      </View>

      {row.kind === "sos" ? (
        <Button
          label="Acknowledge"
          loading={busy}
          onPress={() =>
            void actions.run(row.id, () => acknowledgeSos(row.id), "Acknowledged")
          }
        />
      ) : null}

      {/*
        The receipt itself. Approving a payment claim without looking at the
        proof is the one action here that moves money. Opens in the global
        viewer, so it zooms: the amount on a bank screenshot is small and the
        whole question is whether it matches.
      */}
      {claim?.evidenceAssetId ? (
        <Button
          label="View proof"
          onPress={() =>
            openAssetViewer([
              {
                assetId: claim.evidenceAssetId ?? undefined,
                caption: [claim.method, claim.confirmation].filter(Boolean).join(" · "),
                mimeType: claim.evidenceMimeType ?? undefined,
                title: `Claim for ${formatMoney(claim.amount)}`,
              },
            ])
          }
          variant="secondary"
        />
      ) : null}

      {row.kind === "claim" ? (
        <View className="flex-row gap-2">
          <Button
            className="flex-1"
            label="Approve"
            loading={busy}
            onPress={() =>
              void actions.run(
                row.id,
                () => approveClaim(row.id),
                `Verified ${formatMoney(claim?.amount)}`,
              )
            }
          />
          <Button
            className="flex-1"
            disabled={busy}
            label="Reject"
            onPress={() => actions.ask("reject", row)}
            variant="outline"
          />
        </View>
      ) : null}

      {row.kind === "complaint" ? (
        <Button
          disabled={busy}
          label="Reply"
          onPress={() => actions.ask("reply", row)}
          variant="outline"
        />
      ) : null}

      {/*
        A lead decays in hours, so both of its actions are on the card: ring
        them, and say where it got to. This is where the Residents tab's tinted
        inquiry block went — and it replaces a caption that used to send people
        to the web portal for a job the phone can do standing in the hostel.
      */}
      {row.kind === "inquiry" && inquiry ? (
        <View className="flex-row gap-2">
          {inquiry.phone ? (
            <Button
              className="flex-1"
              label="Call"
              onPress={() => void Linking.openURL(`tel:${inquiry.phone}`)}
            />
          ) : null}
          <Button
            className="flex-1"
            label="Follow up"
            onPress={() => actions.askInquiry(inquiry)}
            variant="outline"
          />
        </View>
      ) : null}

      {row.kind === "inquiry" && !inquiry ? (
        <View className="flex-row items-center gap-2">
          <Glyph
            color={colors.mutedForeground}
            name="information-circle"
            size={16}
          />
          <Text className="flex-1" variant="caption">
            Open the Action queue to answer this one.
          </Text>
        </View>
      ) : null}
    </Card>
  );
}
