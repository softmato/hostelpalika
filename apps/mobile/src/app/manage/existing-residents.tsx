import { File } from "expo-file-system";
import { useCallback, useMemo, useState } from "react";
import { View } from "react-native";

import { RoomPicker } from "@/components/manage/room-picker";
import { ActionCard, ActionCell } from "@/components/ui/action-grid";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { StatTile } from "@/components/ui/layout";
import { CardRow } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonRows } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { adminQuery } from "@/lib/admin-queries";
import { readApiError, readApiErrorDetails } from "@/lib/api-contract";
import { formatDateIn } from "@/lib/calendar";
import { openConfirm } from "@/lib/confirm";
import { downloadToDevice } from "@/lib/documents";
import {
  addExistingResidents,
  clearExistingResidents,
  type ExistingAddResult,
  type ExistingCheck,
  type ExistingResidentsView,
  type ExistingRowField,
  existingResidentsTemplateUrl,
  saveExistingResidents,
  uploadExistingResidentsFile,
} from "@/lib/existing-residents-api";
import {
  blankRow,
  inputFromRow,
  listTotals,
  rentStatusOptions,
  rowSubtitle,
  rupeesFrom,
  sectionsFor,
} from "@/lib/existing-residents";
import { formatMoney } from "@/lib/format";
import { startOfDayIso, toDayInput } from "@/lib/manage-dates";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Residents → Add existing residents (docs/EXISTING_RESIDENTS.md, item 9).
 *
 * The people already living in the hostel when it joined, brought in with what
 * is true today — not the joining flow, which would charge them an admission fee
 * for a room they moved into last year.
 *
 * Built for a warden with a notebook as much as an owner with Excel: the file is
 * one of three ways in, and "Add one" is a short form in a bottom sheet. The list
 * is the web's list — the field team may have started it on a laptop at the
 * counter — so every change is saved to the server, not kept on the phone.
 *
 * Nothing becomes a resident until "Add all", and the footer says what that will
 * bill before anyone presses it.
 */

type PickedFile = { mimeType?: string; name: string; size?: number; uri: string };

type DocumentPickerModule = {
  getDocumentAsync: (options: {
    type?: string[];
  }) => Promise<{ assets: PickedFile[] | null; canceled: boolean }>;
};

/** Required lazily — see the same note in `manage/statements.tsx`. */
function loadDocumentPicker(): DocumentPickerModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("expo-document-picker") as DocumentPickerModule;
  } catch {
    return null;
  }
}

type Draft = {
  depositPaid: string;
  email: string;
  fullName: string;
  id?: string;
  joined: string;
  oldDues: string;
  paidTill: string | null;
  phone: string;
  roomNumber: string;
  roomType: string;
};

function draftFrom(input: ReturnType<typeof blankRow>): Draft {
  return {
    depositPaid: input.depositPaid ? String(input.depositPaid) : "",
    email: input.email,
    fullName: input.fullName,
    id: input.id,
    joined: toDayInput(input.joinedDate),
    oldDues: input.oldDues ? String(input.oldDues) : "",
    paidTill: input.paidTill,
    phone: input.phone,
    roomNumber: input.roomNumber ?? "",
    roomType: input.roomType,
  };
}

const TITLE = "Existing residents";

export default function ExistingResidentsScreen() {
  const { colors } = useAppTheme();
  const query = adminQuery.existingResidents();
  const resource = useResource<ExistingResidentsView>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });
  const view = resource.data;
  const setData = resource.setData;
  const setView = useCallback(
    (next: ExistingResidentsView) => setData(() => next),
    [setData],
  );
  const [notes, setNotes] = useState<string[]>([]);
  const [added, setAdded] = useState<ExistingAddResult | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  const rows = useMemo(() => view?.list?.rows ?? [], [view]);
  const check = view?.check ?? null;
  const sections = useMemo(() => sectionsFor(rows, check), [rows, check]);
  const totals = useMemo(() => listTotals(check), [check]);
  const pending = rows.filter((row) => !row.residentId).length;

  /** Every row not yet added, as the server wants them back. */
  const pendingInputs = useCallback(
    () => rows.filter((row) => !row.residentId).map(inputFromRow),
    [rows],
  );

  const draftProblems = useMemo(() => {
    const found = new Map<ExistingRowField, string>();

    for (const problem of check?.rows.find((row) => row.id === draft?.id)?.problems ?? []) {
      if (!found.has(problem.field)) found.set(problem.field, problem.message);
    }

    return found;
  }, [check, draft?.id]);

  async function saveDraft() {
    if (!draft || !view) return;

    const joinedDate = draft.joined.trim() ? startOfDayIso(draft.joined.trim()) : null;

    if (draft.joined.trim() && !joinedDate) {
      toastError("Joined date looks wrong", "Write it as YYYY-MM-DD, or leave it empty.");
      return;
    }

    const input = {
      depositPaid: rupeesFrom(draft.depositPaid) ?? 0,
      email: draft.email.trim(),
      fullName: draft.fullName.trim(),
      ...(draft.id ? { id: draft.id } : {}),
      joinedDate,
      // The rate card's rent, read by the server.
      monthlyRent: null,
      oldDues: rupeesFrom(draft.oldDues) ?? 0,
      paidTill: draft.paidTill,
      phone: draft.phone.trim(),
      roomNumber: draft.roomNumber,
      roomType: draft.roomType,
    };

    const current = pendingInputs();

    setSaving(true);

    try {
      const next = await saveExistingResidents(
        draft.id ? current.map((row) => (row.id === draft.id ? input : row)) : [...current, input],
      );

      setView(next);
      setAdded(null);
      setDraft(null);
    } catch (error) {
      toastError("Could not save", readApiError(error));
    } finally {
      setSaving(false);
    }
  }

  function removeDraftRow() {
    if (!draft?.id) {
      setDraft(null);
      return;
    }

    const id = draft.id;

    openConfirm({
      confirmLabel: "Remove",
      destructive: true,
      message: `${draft.fullName.trim() || "This line"} is taken off the list.`,
      onConfirm: async () => {
        try {
          setView(await saveExistingResidents(pendingInputs().filter((row) => row.id !== id)));
          setDraft(null);
        } catch (error) {
          toastError("Could not remove", readApiError(error));
        }
      },
      title: "Remove from list?",
    });
  }

  async function download() {
    try {
      await downloadToDevice({
        extension: "xlsx",
        fileName: "existing-residents",
        label: "Existing residents file",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        url: existingResidentsTemplateUrl(),
      });
    } catch (error) {
      toastError("Could not download", readApiError(error));
    }
  }

  async function upload() {
    const picker = loadDocumentPicker();

    if (!picker) {
      toastError("This build cannot open files", "Update the app, or add residents one by one.");
      return;
    }

    const picked = await picker.getDocumentAsync({
      type: [
        "text/csv",
        "text/comma-separated-values",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ],
    });
    const file = picked.canceled ? null : picked.assets?.[0];

    if (!file) return;

    setUploading(true);

    try {
      const result = await uploadExistingResidentsFile({
        contentBase64: await new File(file.uri).base64(),
        fileName: file.name,
      });

      setView(result.view);
      setAdded(null);
      setNotes(result.notes);
      toastSuccess(
        `${result.read} ${result.read === 1 ? "resident" : "residents"} read`,
        result.notes.length ? "Some cells could not be read — see the list." : file.name,
      );
    } catch (error) {
      toastError("Could not read the file", readApiError(error));
    } finally {
      setUploading(false);
    }
  }

  function addAll() {
    if (!check?.ready) return;

    const bills =
      totals.months + totals.dues === 0
        ? "Nothing is billed now."
        : `${totals.months} ${totals.months === 1 ? "month" : "months"} due and ${totals.dues} old ${
            totals.dues === 1 ? "due" : "dues"
          } are billed — ${formatMoney(totals.amount)} in total.`;
    const withEmail = rows.filter((row) => !row.residentId && row.email.trim()).length;
    const told =
      withEmail === check.toAdd
        ? "Each of them gets an email with what they owe."
        : `${withEmail} with an email are told by email. Tell the other ${check.toAdd - withEmail} yourself.`;

    openConfirm({
      confirmLabel: `Add ${check.toAdd}`,
      message: `They are added as living here now, with no admission fee. ${bills} ${told}`,
      onConfirm: async () => {
        try {
          const result = await addExistingResidents();

          setView(result.view);
          setAdded(result.result);
          setNotes([]);
          toastSuccess(
            `${result.result.added} ${result.result.added === 1 ? "resident" : "residents"} added`,
            `${result.result.billsRaised} ${result.result.billsRaised === 1 ? "bill" : "bills"} made`,
          );
        } catch (error) {
          const refused = readApiErrorDetails<{ check?: ExistingCheck }>(error);

          if (refused?.check) {
            setData((current) => (current ? { ...current, check: refused.check! } : current));
          }

          toastError("Could not add", readApiError(error));
        }
      },
      title: `Add ${check.toAdd} residents?`,
    });
  }

  function clearList() {
    openConfirm({
      confirmLabel: "Delete list",
      destructive: true,
      message: "Residents not added yet are removed from this list. Residents already added stay.",
      onConfirm: async () => {
        try {
          setView(await clearExistingResidents());
          setNotes([]);
        } catch (error) {
          toastError("Could not delete", readApiError(error));
        }
      },
      title: "Delete this list?",
    });
  }

  const header = (
    <AppBar accent centerTitle showBack subtitle={view?.hostel.name} title={TITLE} />
  );

  if (!view) {
    return (
      <Screen header={header}>
        {resource.loading ? (
          <SkeletonRows rows={6} />
        ) : (
          <ErrorState
            message={resource.error ?? "The list could not be loaded."}
            onRetry={resource.reload}
          />
        )}
      </Screen>
    );
  }

  const lastAdded = added ?? (rows.length === 0 ? view.lastAdded : null);
  const roomOptions = view.roomTypes.map((room) => ({
    description: [
      `${room.freeBeds} free`,
      room.monthlyRent === null ? "no rent in the rate card" : `${formatMoney(room.monthlyRent)} a month`,
    ].join(" · "),
    label: room.roomType,
    value: room.roomType,
  }));
  const draftRoom = view.roomTypes.find((room) => room.roomType === draft?.roomType);
  /** Floor & room is on: each line goes into a numbered room (docs/FIELD_FIXES_2026_10.md §3). */
  const numberedRooms = view.numberedRooms?.length ? view.numberedRooms : null;
  const draftNumbered = numberedRooms?.find(
    (room) => room.number.toLowerCase() === draft?.roomNumber.trim().toLowerCase(),
  );
  const joinedHint = draft?.joined.trim()
    ? formatDateIn("BS", startOfDayIso(draft.joined.trim()))
    : "Optional · YYYY-MM-DD";

  return (
    <Screen
      footer={
        pending > 0 ? (
          <View className="gap-2">
            <Text className="text-center" variant="caption">
              {check?.withProblems
                ? `${check.withProblems} ${check.withProblems === 1 ? "line needs" : "lines need"} fixing`
                : check?.listProblems.length
                  ? check.listProblems[0]
                  : `${totals.months} ${totals.months === 1 ? "month" : "months"} due · ${formatMoney(totals.amount)} to bill`}
            </Text>
            <Button
              disabled={!check?.ready}
              label={`Add all ${pending} residents`}
              onPress={addAll}
            />
          </View>
        ) : undefined
      }
      header={header}
      onRefresh={resource.refresh}
      refreshing={resource.refreshing}
      scroll
    >
      <View className="gap-5 pt-1">
        <ActionCard>
          <ActionCell
            glyph={colors.primary}
            icon="download"
            label="Download Excel"
            onPress={() => void download()}
            tone="brand"
          />
          <ActionCell
            glyph={colors.primary}
            icon={uploading ? "hourglass" : "cloud-upload"}
            label={uploading ? "Reading…" : "Upload file"}
            onPress={() => {
              if (!uploading) void upload();
            }}
            tone="brand"
          />
          <ActionCell
            glyph={colors.primary}
            icon="person-add"
            label="Add one"
            onPress={() => setDraft(draftFrom(blankRow()))}
            tone="brand"
          />
        </ActionCard>

        {lastAdded ? (
          <Card className="gap-1 border border-success/30 bg-success-soft">
            <Text className="font-semibold text-foreground">
              {lastAdded.added} {lastAdded.added === 1 ? "resident" : "residents"} added ·{" "}
              {lastAdded.billsRaised} {lastAdded.billsRaised === 1 ? "bill" : "bills"} made
            </Text>
            {lastAdded.problems.map((problem, index) => (
              <Text key={index} variant="muted">
                {problem.name}: {problem.message}
              </Text>
            ))}
          </Card>
        ) : null}

        {notes.length || check?.listProblems.length ? (
          <Card className="gap-1 border border-warning/30 bg-warning-soft">
            {[...(check?.listProblems ?? []), ...notes].map((note) => (
              <Text className="text-foreground" key={note} variant="caption">
                {note}
              </Text>
            ))}
          </Card>
        ) : null}

        {rows.length === 0 ? (
          <EmptyCard
            description="Download the Excel file, fill it and upload it. Or add residents one by one."
            title="No residents in the list yet"
          />
        ) : (
          <>
            <View className="flex-row gap-3">
              <StatTile icon="people" label="In list" tone="brand" value={String(pending)} />
              <StatTile
                icon="alert-circle"
                label="To fix"
                tone={check?.withProblems ? "warning" : "neutral"}
                value={String(check?.withProblems ?? 0)}
              />
              <StatTile icon="receipt" label="To bill" value={formatMoney(totals.amount)} />
            </View>

            {sections.map((section) => (
              <View key={section.title}>
                <SectionHeader
                  subtitle={`${section.rows.length} ${section.rows.length === 1 ? "resident" : "residents"}`}
                  title={section.title}
                />
                <View className="gap-3">
                  {section.rows.map(({ checked, row }) => (
                    <CardRow
                      icon={
                        row.residentId
                          ? "checkmark-circle"
                          : checked?.problems.length
                            ? "alert-circle"
                            : "person"
                      }
                      key={row.id}
                      onPress={
                        row.residentId ? undefined : () => setDraft(draftFrom(inputFromRow(row)))
                      }
                      subtitle={rowSubtitle(row, checked, view.currentMonth.period)}
                      title={row.fullName || "No name yet"}
                      tone={row.residentId ? "success" : checked?.problems.length ? "warning" : "brand"}
                      value={
                        !row.residentId && checked?.bills?.total
                          ? formatMoney(checked.bills.total)
                          : undefined
                      }
                    />
                  ))}
                </View>
              </View>
            ))}

            <Text className="px-1" variant="caption">
              This month is {view.currentMonth.label}. Months due and old dues are billed when you
              add the list, and each resident is told what they owe.
            </Text>

            {pending > 0 ? (
              <Button label="Delete list" onPress={clearList} size="sm" variant="ghost" />
            ) : null}
          </>
        )}
      </View>

      <Sheet
        footer={
          <View className="gap-2">
            <Button label={draft?.id ? "Save" : "Add to list"} loading={saving} onPress={() => void saveDraft()} />
            {draft?.id ? (
              <Button label="Remove from list" onPress={removeDraftRow} size="sm" variant="ghost" />
            ) : null}
          </View>
        }
        onClose={() => setDraft(null)}
        open={draft !== null}
        tall
        title={draft?.id ? "Edit resident" : "Add resident"}
      >
        {draft ? (
          <View className="gap-3 pb-2">
            <Input
              autoCapitalize="words"
              error={draftProblems.get("fullName")}
              label="Full name"
              onChangeText={(fullName) => setDraft({ ...draft, fullName })}
              placeholder="Ram Thapa"
              value={draft.fullName}
            />
            <Input
              error={draftProblems.get("phone")}
              keyboardType="phone-pad"
              label="Phone"
              onChangeText={(phone) => setDraft({ ...draft, phone })}
              value={draft.phone}
            />
            <Select
              error={draftProblems.get("roomType") ?? draftProblems.get("monthlyRent")}
              hint={
                draftRoom?.monthlyRent != null
                  ? `${formatMoney(draftRoom.monthlyRent)} a month, from the rate card`
                  : undefined
              }
              label="Room type"
              // A room of another type no longer fits: pick the room again.
              onChange={(roomType) =>
                setDraft({ ...draft, roomNumber: draftNumbered?.roomType === roomType ? draft.roomNumber : "", roomType })
              }
              options={roomOptions}
              placeholder="Choose"
              value={draftRoom ? draftRoom.roomType : null}
            />
            {numberedRooms ? (
              <View className="gap-2">
                <Text variant="label">Which room</Text>
                <RoomPicker
                  onChange={(room) => setDraft({ ...draft, roomNumber: room.number, roomType: room.roomType })}
                  roomType={draftRoom ? draftRoom.roomType : null}
                  rooms={numberedRooms}
                  showType={!draftRoom}
                  value={draftNumbered?.id ?? null}
                />
                {draftProblems.get("roomNumber") ? (
                  <Text className="text-sm text-destructive">{draftProblems.get("roomNumber")}</Text>
                ) : null}
              </View>
            ) : null}
            <Select
              error={draftProblems.get("paidTill")}
              hint={`Is ${view.currentMonth.label} paid? If not, how many months are due?`}
              label="Rent"
              onChange={(paidTill) => setDraft({ ...draft, paidTill })}
              options={rentStatusOptions(view.currentMonth.period, draft.paidTill)}
              placeholder="Paid or months due"
              sheetTitle="Rent"
              value={draft.paidTill}
            />
            <View className="flex-row gap-3">
              <View className="flex-1">
                <Input
                  keyboardType="number-pad"
                  label="Deposit paid (Rs)"
                  onChangeText={(depositPaid) => setDraft({ ...draft, depositPaid })}
                  value={draft.depositPaid}
                />
              </View>
              <View className="flex-1">
                <Input
                  keyboardType="number-pad"
                  label="Old dues (Rs)"
                  onChangeText={(oldDues) => setDraft({ ...draft, oldDues })}
                  value={draft.oldDues}
                />
              </View>
            </View>
            <Input
              error={draftProblems.get("joinedDate")}
              hint={joinedHint || "Write the day as YYYY-MM-DD"}
              keyboardType="numbers-and-punctuation"
              label="Joined date"
              onChangeText={(joined) => setDraft({ ...draft, joined })}
              placeholder="YYYY-MM-DD"
              value={draft.joined}
            />
            <Input
              autoCapitalize="none"
              error={draftProblems.get("email")}
              hint="Optional · connects their app account if they have one"
              keyboardType="email-address"
              label="Email"
              onChangeText={(email) => setDraft({ ...draft, email })}
              value={draft.email}
            />
            <Text variant="caption">
              {draft.paidTill && draft.paidTill < view.currentMonth.period
                ? "The months due are billed when you add the list, and they are told what they owe."
                : "Nothing is billed now. They get their next bill like everyone else."}
            </Text>
          </View>
        ) : null}
      </Sheet>
    </Screen>
  );
}
