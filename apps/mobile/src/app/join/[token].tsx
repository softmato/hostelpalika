import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { View } from "react-native";

import { Avatar } from "@/components/ui/avatar";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Chip, FactRow } from "@/components/ui/layout";
import { Screen } from "@/components/ui/screen";
import { Select } from "@/components/ui/select";
import { SkeletonCard } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppSelector } from "@/hooks/redux";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useResource } from "@/hooks/use-resource";
import { readApiError } from "@/lib/api-contract";
import { revalidateSession } from "@/lib/auth-session";
import { formatDateIn } from "@/lib/calendar";
import { monthName, rentStatusOptions, rupeesFrom } from "@/lib/existing-residents";
import { formatMoney } from "@/lib/format";
import { identityPhotoSource, setIdentitySharing } from "@/lib/identity-api";
import { getJoinPage, type JoinPage, type JoinRequest, sendJoinRequest } from "@/lib/join-api";
import { startOfDayIso } from "@/lib/manage-dates";
import { toastError, toastSuccess } from "@/lib/toast";
import { addBsMonths } from "@hostel/calendar/bs";

/**
 * `/join/{token}` — adding yourself to the hostel you already live in
 * (docs/EXISTING_RESIDENTS.md, "Join link"). The app's side of the web page
 * `apps/web/src/app/(public)/join/[token]`, and the same steps in the same
 * order: an account, an ID card the hostel can see, then room and rent.
 *
 * Reached from the "Fix my request" notification, from
 * `hostelpalika://join/{token}`, and — once the native build carries the
 * `/join/` app link — straight from WhatsApp.
 */

type Draft = {
  depositPaid: string;
  joinedDate: string;
  note: string;
  paidTill: string | null;
  partPaid: string;
  roomType: string | null;
};

function draftFrom(request: JoinRequest | null): Draft {
  return {
    depositPaid: request?.depositPaid ? String(request.depositPaid) : "",
    joinedDate: request?.joinedDate ? request.joinedDate.slice(0, 10) : "",
    note: request?.note ?? "",
    paidTill: request?.paidTill ?? null,
    partPaid: request?.partPaid ? String(request.partPaid) : "",
    roomType: request?.roomType ?? null,
  };
}

/** Months after `paidTill` up to and including this one — what will be billed. */
function monthsDue(paidTill: string | null, period: string) {
  let count = 0;

  for (let month = paidTill ? addBsMonths(paidTill, 1) : period; paidTill && month <= period; month = addBsMonths(month, 1)) {
    count += 1;
  }

  return count;
}

export default function JoinScreen() {
  const { token = "" } = useLocalSearchParams<{ token: string }>();
  const signedIn = useAppSelector((state) => Boolean(state.auth.accessToken));
  const page = useResource<JoinPage>(
    useCallback(() => getJoinPage(token), [token]),
    { cacheKey: `join:${token}:${signedIn ? "in" : "out"}` },
  );
  const [editing, setEditing] = useState(false);
  const firstFocus = useRef(true);

  // Back from making the ID card or from signing in: read the link again.
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }

      page.refresh();
      // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh is stable; page is not
    }, [page.refresh]),
  );

  const header = <AppBar showBack title="Join your hostel" />;

  if (page.loading) {
    return (
      <Screen header={header} scroll>
        <SkeletonCard />
      </Screen>
    );
  }

  if (page.error || !page.data) {
    return (
      <Screen header={header}>
        <ErrorState message={page.error ?? "This link could not be opened."} onRetry={page.reload} />
      </Screen>
    );
  }

  const view = page.data;
  const viewer = view.viewer;
  const request = view.request;
  const showForm =
    viewer?.card === "READY" &&
    !viewer.livesAt &&
    (editing || !request || request.status === "ADDED") &&
    (request ? view.link !== "OFF" : view.link === "OPEN");

  return (
    <Screen header={header} onRefresh={page.refresh} refreshing={page.refreshing} scroll>
      <View className="gap-5">
        <View className="-mt-1">
          <View className="gap-1 rounded-b-3xl bg-primary px-5 pb-12 pt-4">
            <Text className="text-xs font-bold uppercase tracking-wide text-primary-foreground/75">
              Join as a resident
            </Text>
            <Text className="text-xl font-bold text-primary-foreground">{view.hostel.name}</Text>
            {view.hostel.city ? (
              <Text className="text-sm text-primary-foreground/80">{view.hostel.city}</Text>
            ) : null}
          </View>
          <View className="-mt-8 px-1">
            <WhoCard
              onShared={page.refresh}
              token={token}
              view={view}
            />
          </View>
        </View>

        {!viewer ? null : viewer.livesAt ? (
          <Card className="gap-3">
            <Text variant="label">
              {viewer.livesAt.sameHostel
                ? "You are a resident here"
                : `You live at ${viewer.livesAt.hostelName}`}
            </Text>
            <Text variant="muted">
              {viewer.livesAt.sameHostel
                ? `${view.hostel.name} has added you. Your rent and bills are in the app.`
                : `One person lives in one hostel. Ask ${viewer.livesAt.hostelName} to move you out first, then open this link again.`}
            </Text>
            {viewer.livesAt.sameHostel ? (
              <Button
                label="Open my home"
                onPress={async () => {
                  // The account just became a resident's: rotate the session so the app routes there.
                  await revalidateSession().catch(() => null);
                  router.replace("/(resident)");
                }}
              />
            ) : null}
          </Card>
        ) : showForm ? (
          <JoinForm
            initial={editing || request?.status === "REJECTED" ? request : null}
            onCancel={request && request.status !== "ADDED" ? () => setEditing(false) : undefined}
            onSent={(next) => {
              page.setData(() => next);
              setEditing(false);
              toastSuccess("Sent", `${view.hostel.name} will check it and add you.`);
            }}
            token={token}
            view={view}
          />
        ) : request && request.status !== "ADDED" ? (
          <RequestStatus
            hostelName={view.hostel.name}
            linkOff={view.link === "OFF"}
            onEdit={() => setEditing(true)}
            request={request}
          />
        ) : viewer.card === "READY" && request?.status !== "ADDED" ? (
          <Card className="gap-2">
            <Text variant="label">{view.link === "FULL" ? "This link is full" : "This link is paused"}</Text>
            <Text variant="muted">
              {view.link === "FULL"
                ? `${view.hostel.name} has had all the requests it allowed. Ask them to allow more.`
                : `${view.hostel.name} has turned this link off for now. Ask them.`}
            </Text>
          </Card>
        ) : null}
      </View>
    </Screen>
  );
}

/** Signed out, no card, a private card — or the card the hostel will check. */
function WhoCard({
  onShared,
  token,
  view,
}: {
  onShared: () => void;
  token: string;
  view: JoinPage;
}) {
  const accessToken = useAppSelector((state) => state.auth.accessToken);
  const [sharing, setSharing] = useState(false);
  const viewer = view.viewer;

  if (!viewer) {
    return (
      <Card className="gap-3">
        <Text variant="label">Already living at {view.hostel.name}?</Text>
        <Text variant="muted">
          Add yourself in a minute. Your hostel checks it and adds you — no joining fee, only the rent
          still due.
        </Text>
        <Button
          label="Log in"
          onPress={() =>
            router.push({ params: { next: `/join/${token}` }, pathname: "/(auth)/login" })
          }
        />
        <Button
          label="Make an account"
          onPress={() => router.push("/(auth)/register")}
          variant="outline"
        />
      </Card>
    );
  }

  if (viewer.card === "NONE") {
    return (
      <Card className="gap-3">
        <Text variant="label">Make your ID card first</Text>
        <Text variant="muted">
          {view.hostel.name} checks you against your ID card — your photo, name and phone. You make it
          once and use it in any hostel.
        </Text>
        <Button label="Make my ID card" onPress={() => router.push("/id-card/edit")} />
      </Card>
    );
  }

  if (viewer.card === "PRIVATE") {
    return (
      <Card className="gap-3">
        <Text variant="label">Your ID card is private</Text>
        <Text variant="muted">
          Hostels cannot see it, so {view.hostel.name} cannot check you. Turn on sharing to send your
          request.
        </Text>
        <Button
          label="Share my ID card with hostels"
          loading={sharing}
          onPress={async () => {
            setSharing(true);

            try {
              await setIdentitySharing(true);
              onShared();
            } catch (error) {
              toastError("Could not turn on sharing", readApiError(error));
            } finally {
              setSharing(false);
            }
          }}
        />
      </Card>
    );
  }

  const photo = identityPhotoSource(
    { hasPhoto: viewer.hasPhoto, photoUpdatedAt: viewer.photoUpdatedAt },
    accessToken,
  );

  return (
    <Card className="flex-row items-center gap-3">
      <Avatar headers={photo?.headers} name={viewer.fullName} size="lg" uri={photo?.uri} />
      <View className="min-w-0 flex-1">
        <Text className="text-base font-bold" numberOfLines={1}>
          {viewer.fullName}
        </Text>
        <Text numberOfLines={1} variant="muted">
          {viewer.phone}
        </Text>
        <Text className="text-xs" variant="muted">
          {viewer.cardId} · your ID card
        </Text>
      </View>
    </Card>
  );
}

function JoinForm({
  initial,
  onCancel,
  onSent,
  token,
  view,
}: {
  initial: JoinRequest | null;
  onCancel?: () => void;
  onSent: (view: JoinPage) => void;
  token: string;
  view: JoinPage;
}) {
  const { colors } = useAppTheme();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(initial));
  const [busy, setBusy] = useState(false);
  const period = view.currentMonth.period;
  const options = rentStatusOptions(period, draft.paidTill);
  const due = monthsDue(draft.paidTill, period);
  const firstDue = draft.paidTill ? addBsMonths(draft.paidTill, 1) : null;
  const room = view.roomTypes.find((candidate) => candidate.roomType === draft.roomType);
  const estimate = room?.monthlyRent && due > 0 ? room.monthlyRent * due - (rupeesFrom(draft.partPaid) ?? 0) : 0;
  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const joinedIso = draft.joinedDate.trim() ? startOfDayIso(draft.joinedDate.trim()) : null;

  async function send() {
    if (!draft.roomType) return toastError("Choose your room type");
    if (!draft.paidTill) return toastError(`Choose if ${view.currentMonth.label} rent is paid`);
    if (draft.joinedDate.trim() && !joinedIso) return toastError("Write the day as YYYY-MM-DD");

    setBusy(true);

    try {
      onSent(
        await sendJoinRequest(token, {
          depositPaid: rupeesFrom(draft.depositPaid) ?? 0,
          joinedDate: joinedIso,
          note: draft.note.trim(),
          paidTill: draft.paidTill,
          partPaid: due > 0 ? (rupeesFrom(draft.partPaid) ?? 0) : 0,
          roomType: draft.roomType,
        }),
      );
    } catch (error) {
      toastError("Not sent", readApiError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View className="gap-5">
      {initial?.status === "REJECTED" ? (
        <Card className="flex-row gap-3 bg-warning-soft">
          <Ionicons color={colors.warning} name="arrow-undo" size={20} />
          <View className="flex-1">
            <Text className="font-semibold">{view.hostel.name} sent it back</Text>
            <Text variant="muted">{initial.rejectReason}</Text>
          </View>
        </Card>
      ) : null}

      <View>
        <SectionHeader subtitle="Rent is the hostel's rate for that room" title="Your room type" />
        <Card>
          <View className="flex-row flex-wrap gap-2">
            {view.roomTypes.map((candidate) => (
              <Chip
                icon="bed-outline"
                key={candidate.roomType}
                label={
                  candidate.monthlyRent
                    ? `${candidate.roomType} · ${formatMoney(candidate.monthlyRent)}`
                    : candidate.roomType
                }
                onPress={() => set({ roomType: candidate.roomType })}
                tone={draft.roomType === candidate.roomType ? "brand" : "neutral"}
              />
            ))}
          </View>
        </Card>
      </View>

      <View>
        <SectionHeader title={`Is ${monthName(period)} rent paid?`} />
        <Card className="gap-3">
          <View className="flex-row flex-wrap gap-2">
            {options.slice(0, 6).map((option, index) => (
              <Chip
                icon={index === 0 ? "checkmark-circle-outline" : "time-outline"}
                key={option.value}
                label={index === 0 ? "Paid" : option.label}
                onPress={() => set({ paidTill: option.value })}
                tone={draft.paidTill === option.value ? "brand" : "neutral"}
              />
            ))}
          </View>
          <Select
            label="More months"
            onChange={(value) => set({ paidTill: value })}
            options={options}
            placeholder="Paid or months due"
            sheetTitle="Rent"
            value={draft.paidTill}
          />
          {due > 0 && firstDue ? (
            <Input
              hint="Optional · it comes off that month's bill"
              keyboardType="number-pad"
              label={`Paid part of ${monthName(firstDue).replace(/\s+\d{4}$/, "")} rent already? (Rs)`}
              onChangeText={(text) => set({ partPaid: text })}
              value={draft.partPaid}
            />
          ) : null}
        </Card>
      </View>

      <View>
        <SectionHeader subtitle="All optional" title="More" />
        <Card className="gap-3">
          <Input
            keyboardType="number-pad"
            label="Deposit you paid (Rs)"
            onChangeText={(text) => set({ depositPaid: text })}
            value={draft.depositPaid}
          />
          <Input
            hint={joinedIso ? formatDateIn("BS", joinedIso) : "YYYY-MM-DD"}
            keyboardType="numbers-and-punctuation"
            label="Moved in on"
            onChangeText={(text) => set({ joinedDate: text })}
            placeholder="YYYY-MM-DD"
            value={draft.joinedDate}
          />
          <Input
            label="Note for the warden"
            maxLength={300}
            multiline
            onChangeText={(text) => set({ note: text })}
            placeholder="e.g. Paid Rs 3,000 cash to Hari dai"
            value={draft.note}
          />
        </Card>
      </View>

      {estimate > 0 ? (
        <Card className="flex-row items-center justify-between">
          <Text variant="muted">About what you will owe</Text>
          <Text className="font-bold">{formatMoney(estimate)}</Text>
        </Card>
      ) : null}

      <Card className="flex-row gap-3 bg-warning-soft">
        <Ionicons color={colors.warning} name="alert-circle" size={20} />
        <Text className="flex-1 text-sm">
          Your hostel owner or warden checks this against their own book. Fill it in correctly —
          wrong details can mean extra charges.
        </Text>
      </Card>

      <View className="flex-row gap-3">
        {onCancel ? (
          <View className="flex-1">
            <Button disabled={busy} label="Cancel" onPress={onCancel} variant="outline" />
          </View>
        ) : null}
        <View className="flex-1">
          <Button
            label={initial ? "Send again" : "Send"}
            loading={busy}
            onPress={() => void send()}
          />
        </View>
      </View>
    </View>
  );
}

function RequestStatus({
  hostelName,
  linkOff,
  onEdit,
  request,
}: {
  hostelName: string;
  linkOff: boolean;
  onEdit: () => void;
  request: JoinRequest;
}) {
  const returned = request.status === "REJECTED";

  return (
    <View className="gap-3">
      <Card className={`gap-1 ${returned ? "bg-warning-soft" : ""}`}>
        <Text variant="label">{returned ? "Sent back to you" : `Sent to ${hostelName}`}</Text>
        <Text variant="muted">
          {returned
            ? request.rejectReason
            : "They check it against their book and add you. You get a message when they do."}
        </Text>
      </Card>

      <Card padding="px-4 py-1">
        <FactRow label="Room type" value={request.roomType} />
        <FactRow label="Rent" value={request.rentLabel} />
        {request.partPaid ? <FactRow label="Part paid" value={formatMoney(request.partPaid)} /> : null}
        <FactRow label="Deposit paid" value={formatMoney(request.depositPaid)} />
        {request.bills ? <FactRow label="Due when added" value={formatMoney(request.bills.total)} /> : null}
      </Card>

      {linkOff ? (
        <Text variant="muted">The hostel has paused this link, so it cannot be changed now.</Text>
      ) : (
        <Button
          label={returned ? "Fix and send again" : "Change something"}
          onPress={onEdit}
          variant={returned ? "primary" : "outline"}
        />
      )}
    </View>
  );
}
