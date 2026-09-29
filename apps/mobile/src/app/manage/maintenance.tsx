import { Ionicons } from "@expo/vector-icons";
import { useCallback, useMemo, useState } from "react";
import { Linking, Pressable, ScrollView, View } from "react-native";
import Animated, {
  FadeIn,
  FadeOut,
  LinearTransition,
} from "react-native-reanimated";

import { Image } from "expo-image";

import { ServiceCarousel, type ServiceCard } from "@/components/service-carousel";
import { VoiceNotePlayer } from "@/components/voice-note-player";
import { VoiceNoteRecorder, type VoiceNote } from "@/components/voice-note-recorder";
import { AppBar } from "@/components/ui/app-bar";
import { Badge, StatusPill } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { FloatingButton } from "@/components/ui/floating-button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Chip } from "@/components/ui/layout";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonRows } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import {
  assignMaintenanceProvider,
  commentOnMaintenance,
  createMaintenanceRequest,
  MAINTENANCE_CATEGORIES,
  type MaintenanceCategory,
  type MaintenancePriority,
  type MaintenanceStatus,
  type ManagedMaintenanceRequest,
  updateMaintenanceStatus,
} from "@/lib/admin-manage-api";
import { type AdminMaintenanceData, adminQuery } from "@/lib/admin-queries";
import { readApiError } from "@/lib/api-contract";
import { formatMoney, humanizeEnum } from "@/lib/format";
import {
  chargeNote,
  minimumChargeFor,
  searchServices,
  titleForRequest,
} from "@/lib/maintenance-services";
import {
  categoryForRole,
  providerRoleLabel,
  suggestPriority,
  suggestProviderRoles,
} from "@/lib/maintenance-suggest";
import { dayInputFromNow, startOfDayIso, toDayInput } from "@/lib/manage-dates";
import { groupNotifications } from "@/lib/notification-groups";
import { toastError, toastSuccess } from "@/lib/toast";
import { tradeArtUri } from "@/lib/trade-art";
import { uploadAsset } from "@/lib/uploads";
import { formatDuration } from "@/lib/voice-note";

/**
 * Maintenance — the queue, plus the directory of people who fix things.
 *
 * ## The trade is a deck of cards, not a dropdown
 *
 * `CATEGORY_OPTIONS` used to be a `<Select>` of eleven shouted enum names with
 * no price anywhere on the sheet, so the first time a hostel saw a figure was on
 * the invoice. It is now a searchable carousel where every card carries what
 * that call-out costs, and `Raise it` opens a confirmation of the charge before
 * anything is written. See `components/service-carousel.tsx` for why a carousel
 * is right here and wrong everywhere else in the app.
 *
 * ## Raising a request is one sentence, not a form
 *
 * The web asks for a title, a category, a priority, a location and a provider.
 * Four of those five can be read out of the sentence somebody would type anyway
 * — "tap in room 204 is leaking, urgent" gives the title, the category, the
 * priority and the role to call — so the sheet leads with the problem text and
 * fills the rest in, visibly, as suggestions the admin can override. The
 * scoring is `lib/maintenance-suggest.ts`, a copy of the web's own rules.
 *
 * ## Raised requests go to the provider board
 *
 * Nobody is picked on the sheet. A raised request lands on every provider's job
 * board; the ones in that trade get a push, and the first to accept takes it
 * (owner's call, 2026-09-24). The request sheet can still assign somebody by
 * hand while nobody has accepted. There is no reassign: a request that went to
 * the wrong person is cancelled with a note and raised again.
 *
 * ## The list already carries the thread
 *
 * `GET .../requests` returns each request with its `comments` and `history`
 * inline, so opening one costs nothing and there is no detail fetch. Do not add
 * one.
 *
 * ## Internal notes are internal
 *
 * A comment's `visibility` is `INTERNAL` or `PROVIDER_NOTE`, and the sheet makes
 * you pick. That distinction is invisible on the phone otherwise, and "the cost
 * seems high, get a second quote" reaching the plumber it is about is the exact
 * failure the flag exists to prevent.
 */

type Filter = "all" | "open" | "scheduled" | "done";

const FILTER_STATUSES: Record<Filter, readonly string[]> = {
  all: [],
  done: ["COMPLETED", "CANCELLED"],
  open: ["PENDING", "CONTACTED"],
  scheduled: ["SCHEDULED"],
};

const PRIORITY_OPTIONS: { description: string; label: string; value: MaintenancePriority }[] = [
  { description: "Whenever somebody is passing.", label: "Low", value: "LOW" },
  { description: "The normal case.", label: "Medium", value: "MEDIUM" },
  { description: "This week, and it is annoying people.", label: "High", value: "HIGH" },
  { description: "Today. Somebody could be hurt.", label: "Urgent", value: "URGENT" },
];

const STATUS_OPTIONS: { description: string; label: string; value: MaintenanceStatus }[] = [
  { description: "Nobody has been called yet.", label: "Pending", value: "PENDING" },
  { description: "You have spoken to somebody.", label: "Contacted", value: "CONTACTED" },
  { description: "They are coming on a known day.", label: "Scheduled", value: "SCHEDULED" },
  { description: "Fixed, and you have seen it.", label: "Completed", value: "COMPLETED" },
  { description: "Not going ahead.", label: "Cancelled", value: "CANCELLED" },
];

const PRIORITY_TONE: Record<string, "danger" | "info" | "neutral" | "warning"> = {
  HIGH: "warning",
  LOW: "neutral",
  MEDIUM: "info",
  URGENT: "danger",
};

/**
 * What the raise sheet is holding.
 *
 * `location` and `providerId` were fields here until 2026-09-02. The room number
 * is the first thing anybody says into the recording, so a box asking for it
 * again was the sheet not trusting its own headline feature; and the provider is
 * now chosen on the request itself, once it exists. See the notes in the sheet.
 */
type NewDraft = {
  category: MaintenanceCategory | null;
  priority: MaintenancePriority | null;
  problem: string;
};

const BLANK_NEW: NewDraft = {
  category: null,
  priority: null,
  problem: "",
};

/*
 * `MaintenanceData` and its loader are `adminQuery.maintenance(status)` — see
 * `lib/admin-queries.ts`.
 */

export default function ManageMaintenanceScreen() {
  const dates = useDates();
  const { colors } = useAppTheme();
  const [filter, setFilter] = useState<Filter>("all");
  const [raising, setRaising] = useState(false);
  /** Narrows the deck of trades. Its own state — it is not part of the request. */
  const [serviceQuery, setServiceQuery] = useState("");
  /** The confirmation of the charge, between `Raise it` and the POST. */
  const [confirming, setConfirming] = useState(false);
  const [chargesOpen, setChargesOpen] = useState(false);
  /**
   * The recording in hand, still on this phone.
   *
   * It is uploaded on the confirm step, not while it is being made — recording
   * straight to storage would leave an orphan behind every re-record and every
   * abandoned sheet, and nothing sweeps those up.
   */
  const [voiceNote, setVoiceNote] = useState<VoiceNote | null>(null);
  /**
   * Which half of the problem block is open — and audio is the default.
   *
   * The owner's call (2026-09-02): *"first priority goes to the audio clip"*,
   * with the typed box hidden behind a button that becomes the field when it is
   * pressed, and the recorder collapsing to a *Speak the problem* button in
   * return. Two controls that are each other's undo, so only ever one of them is
   * a box on screen.
   *
   * It is a mode, not two independent fields, because the request has one
   * description and offering both at once is offering to write it twice.
   */
  const [problemMode, setProblemMode] = useState<"speak" | "type">("speak");
  const [draft, setDraft] = useState<NewDraft>(BLANK_NEW);
  const [open, setOpen] = useState<ManagedMaintenanceRequest | null>(null);
  const [statusDraft, setStatusDraft] = useState<MaintenanceStatus>("CONTACTED");
  const [statusNote, setStatusNote] = useState("");
  const [costNote, setCostNote] = useState("");
  const [scheduledOn, setScheduledOn] = useState("");
  const [comment, setComment] = useState("");
  const [commentInternal, setCommentInternal] = useState(true);
  const [busy, setBusy] = useState(false);
  const [providersOpen, setProvidersOpen] = useState(false);

  /*
   * The request goes out unfiltered and the segments cut the result locally.
   * `?status=` takes one value, the segments group two apiece, and the route's
   * own `summary` counts what it returned — asking the server for PENDING would
   * make the summary say "all of them are pending", which is the trap
   * `admin-api.ts` already documents for Today's copy of this call.
   */
  const query = adminQuery.maintenance("");
  const data = useResource<AdminMaintenanceData>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  const requests = useMemo(
    () => data.data?.maintenance?.requests ?? [],
    [data.data],
  );
  const providers = useMemo(() => data.data?.providers ?? [], [data.data]);

  const counts = useMemo(
    () => ({
      all: requests.length,
      done: requests.filter((request) => FILTER_STATUSES.done.includes(request.status)).length,
      open: requests.filter((request) => FILTER_STATUSES.open.includes(request.status)).length,
      scheduled: requests.filter((request) => request.status === "SCHEDULED").length,
    }),
    [requests],
  );

  const visible = useMemo(
    () =>
      filter === "all"
        ? requests
        : requests.filter((request) => FILTER_STATUSES[filter].includes(request.status)),
    [filter, requests],
  );

  /*
   * Newest first, then under day headings. The server sorts by status before
   * date, which inside a "Today" heading would put a cancelled job above the
   * one raised a minute ago.
   */
  const groups = useMemo(
    () =>
      groupNotifications(
        [...visible].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "")),
      ),
    [visible],
  );

  const charges = useMemo(() => data.data?.charges ?? [], [data.data]);

  const suggestions = useMemo(() => suggestProviderRoles(draft.problem), [draft.problem]);
  const suggestedCategory = draft.category ?? (suggestions[0] ? suggestions[0].category : null);
  const suggestedPriority = draft.priority ?? (draft.problem ? suggestPriority(draft.problem) : null);

  /** The deck: every trade, or the ones matching what was typed above it. */
  const serviceCards = useMemo<ServiceCard[]>(
    () =>
      searchServices(MAINTENANCE_CATEGORIES, serviceQuery).map((category) => ({
        id: category,
        label: humanizeEnum(category),
        note: chargeNote(minimumChargeFor(charges, category)),
      })),
    [charges, serviceQuery],
  );

  /**
   * Providers who could take the request currently open, matched on its trade.
   *
   * Separate from `matchingProviders`, which follows the *draft* on the raise
   * sheet: the two are looking at different requests, and sharing one memo would
   * have offered a plumber for whichever job the sheet happened to be composing.
   */
  const assignableProviders = useMemo(() => {
    if (!open) {
      return [];
    }

    return providers.filter(
      (provider) =>
        categoryForRole(provider.category) === open.category ||
        provider.categories.some((role) => categoryForRole(role) === open.category),
    );
  }, [open, providers]);

  const { refresh } = data;

  /** What the confirm step is about to commit the hostel to, or null. */
  const quotedCharge = minimumChargeFor(charges, suggestedCategory);

  /*
   * `Raise it` validates and opens the confirmation. Nothing is written here.
   *
   * The validation lives on this side rather than inside the confirmation so a
   * missing problem sentence is caught on the sheet that has the field in it —
   * being told to write more on a screen with nowhere to write is the shape of
   * error message people close the app over.
   */
  const askToRaise = useCallback(() => {
    /*
     * Either a recording or a sentence — not neither, and not both required.
     *
     * The old check demanded typed words, which since the sheet started
     * defaulting to audio would have refused the exact request it is now
     * designed for. What it must still refuse is an empty one: a request with no
     * description in either form is a row saying "Plumbing job" and nothing
     * else, and the person who has to act on it has no way to ask.
     */
    if (!voiceNote && draft.problem.trim().length < 2) {
      toastError(
        "Describe the problem",
        "Record a few seconds, or type it instead.",
      );
      return;
    }

    setConfirming(true);
  }, [draft.problem, voiceNote]);

  const raise = useCallback(async () => {
    const problem = draft.problem.trim();

    if (!voiceNote && problem.length < 2) {
      toastError("Describe the problem", "Record a few seconds, or type it instead.");
      return;
    }

    setBusy(true);

    try {
      /*
       * The bytes go up before the request exists, because the request carries
       * the asset id and there is no route that attaches one afterwards.
       *
       * A failed upload **stops the raise** rather than quietly raising the job
       * without the recording: somebody who just spent thirty seconds describing
       * a leak has to be told it did not go, not discover it when the plumber
       * rings to ask what the problem is. Progress is the global toaster's job —
       * `uploadAsset` registers itself, and this screen draws no bar of its own.
       */
      const voiceNoteAssetId = voiceNote
        ? await uploadAsset(
            {
              fileName: `voice-note-${Date.now()}.m4a`,
              fileSize: undefined,
              mimeType: "audio/x-m4a",
              uri: voiceNote.uri,
            },
            {
              // Explicit, though it is also the default: this recording names
              // rooms and often has residents audible behind it, so it must land
              // in the bucket with no public base URL.
              accessLevel: "PRIVATE",
              kind: "MAINTENANCE_NOTE",
              label: "Voice note",
            },
          )
        : undefined;

      await createMaintenanceRequest({
        category: suggestedCategory ?? "OTHER",
        description: problem || undefined,
        priority: suggestedPriority ?? "MEDIUM",
        title: titleForRequest(problem, suggestedCategory),
        voiceNoteAssetId,
      });

      toastSuccess(
        "Request raised",
        voiceNote
          ? "Your voice note went with it. Providers in that trade have been notified."
          : "Providers in that trade have been notified.",
      );
      setConfirming(false);
      setRaising(false);
      setDraft(BLANK_NEW);
      setServiceQuery("");
      setVoiceNote(null);
      setProblemMode("speak");
      await refresh();
    } catch (error) {
      toastError("Could not raise it", readApiError(error));
    } finally {
      setBusy(false);
    }
  }, [draft, refresh, suggestedCategory, suggestedPriority, voiceNote]);

  const applyStatus = useCallback(async () => {
    if (!open) {
      return;
    }

    if (statusDraft === "SCHEDULED" && scheduledOn && !startOfDayIso(scheduledOn)) {
      toastError("Check the date", "Write it as YYYY-MM-DD.");
      return;
    }

    setBusy(true);

    try {
      await updateMaintenanceStatus(open.id, {
        costNote: costNote.trim() || undefined,
        note: statusNote.trim() || undefined,
        scheduledFor:
          statusDraft === "SCHEDULED" && scheduledOn
            ? (startOfDayIso(scheduledOn) ?? undefined)
            : undefined,
        status: statusDraft,
      });

      toastSuccess(`Marked ${humanizeEnum(statusDraft).toLowerCase()}`);
      setOpen(null);
      setStatusNote("");
      setCostNote("");
      setScheduledOn("");
      await refresh();
    } catch (error) {
      toastError("Could not update", readApiError(error));
    } finally {
      setBusy(false);
    }
  }, [costNote, open, refresh, scheduledOn, statusDraft, statusNote]);

  /*
   * Which provider chip was tapped. Not `busy`: that flag draws the footer's
   * "Apply status" spinner, so assigning a plumber reported that a status change
   * was being saved — the wrong sentence about the right wait.
   */
  const [assigning, setAssigning] = useState<string | null>(null);

  const assignProvider = useCallback(
    async (providerId: string) => {
      if (!open) {
        return;
      }

      setAssigning(providerId);

      try {
        await assignMaintenanceProvider(open.id, providerId);
        toastSuccess(
          "Assigned",
          "It is in their job list now, with the voice note if you recorded one.",
        );
        setOpen(null);
        await refresh();
      } catch (error) {
        toastError(
          "Could not assign",
          readApiError(error, "Somebody may already be on this job."),
        );
      } finally {
        setAssigning(null);
      }
    },
    [open, refresh],
  );

  const addComment = useCallback(async () => {
    if (!open || comment.trim().length === 0) {
      return;
    }

    setBusy(true);

    try {
      await commentOnMaintenance(open.id, {
        message: comment.trim(),
        visibility: commentInternal ? "INTERNAL" : "PROVIDER_NOTE",
      });
      setComment("");
      toastSuccess(commentInternal ? "Note added" : "Note left for the provider");
      await refresh();
    } catch (error) {
      toastError("Could not add that", readApiError(error));
    } finally {
      setBusy(false);
    }
  }, [comment, commentInternal, open, refresh]);

  const openRequest = useCallback((request: ManagedMaintenanceRequest) => {
    setOpen(request);
    // Pre-set to the next sensible step rather than to what it already is —
    // nobody opens this sheet to mark a pending request pending.
    setStatusDraft(
      request.status === "PENDING"
        ? "CONTACTED"
        : request.status === "CONTACTED"
          ? "SCHEDULED"
          : "COMPLETED",
    );
    setScheduledOn(toDayInput(request.scheduledFor) || dayInputFromNow(1));
    setStatusNote("");
    setCostNote(request.costNote ?? "");
  }, []);

  const providerFor = useCallback(
    (providerId?: string) => providers.find((provider) => provider.id === providerId) ?? null,
    [providers],
  );

  return (
    <Screen
      floating={
        <FloatingButton
          icon="build-outline"
          label="Raise a request"
          onPress={() => {
            setDraft(BLANK_NEW);
            setRaising(true);
          }}
        />
      }
      header={
        <AppBar
          accent
          actions={
            <View className="flex-row items-center">
              {/*
                The charge list is a small glyph and the directory is a word:
                the prices are fixed by the platform and only ever looked at,
                so they get the quieter control.
              */}
              <IconButton
                label="Call-out charges"
                name="pricetag-outline"
                onPress={() => setChargesOpen(true)}
                size="sm"
                tone="onAccent"
              />
              <Button
                label="Providers"
                onPress={() => setProvidersOpen(true)}
                size="sm"
                variant="ghost"
              />
            </View>
          }
          centerTitle
          showBack
          title="Maintenance"
        />
      }
      onRefresh={data.refresh}
      refreshing={data.refreshing}
      scroll
    >
      <View className="gap-4 pt-1">
        <Segmented
          onChange={setFilter}
          options={[
            { count: counts.all, label: "All", value: "all" },
            { count: counts.open, label: "Open", value: "open" },
            { count: counts.scheduled, label: "Booked", value: "scheduled" },
            { count: counts.done, label: "Closed", value: "done" },
          ]}
          value={filter}
        />

        {data.loading ? <SkeletonRows rows={4} /> : null}

        {data.error ? <ErrorState message={data.error} onRetry={data.reload} /> : null}

        {!data.loading && !data.error && visible.length === 0 ? (
          <EmptyCard
            description={
              filter === "all"
                ? "Nothing has been reported. Raise one yourself with the button below."
                : "Nothing in this state right now."
            }
            title="No requests"
          />
        ) : null}

        {groups.map((group) => (
          <View className="gap-2" key={group.bucket}>
            {/* On the page, not in a card: the day is said once for the rows under it. */}
            <Text className="px-0.5 font-semibold uppercase tracking-wider" variant="caption">
              {group.label}
            </Text>
            {group.rows.map((request) => (
              <RequestRow
                key={request.id}
                onOpen={() => openRequest(request)}
                provider={providerFor(request.providerId)}
                request={request}
              />
            ))}
          </View>
        ))}
      </View>

      {/* ------------------------------------------------------------------ */}
      {/* Raise                                                              */}
      {/* ------------------------------------------------------------------ */}
      <Sheet
        /*
          `Raise it` opens the confirmation rather than posting.

          The sketch is explicit that the charge is agreed *before* the request
          exists, and it is the right call for a reason the sketch does not have
          to state: a maintenance request commits the hostel to money, and this
          is the last screen before it does. `askToRaise` only validates and
          opens; `raise` is what writes.
        */
        footer={<Button label="Raise it" loading={busy} onPress={askToRaise} />}
        onClose={() => setRaising(false)}
        open={raising}
        title="What needs fixing?"
      >
        <View className="gap-3 pb-2">
          {/*
            The deck of trades, and the field that narrows it.

            Owner's sketch, 2026-09-02: a search box over a row of swipeable
            cards, one card per service, each carrying what that call-out costs
            — then Raise, then a confirmation of the charge before anything is
            committed. What it replaces is a `<Select>` of eleven shouted enum
            names with the price nowhere on the screen, so the first time
            anybody saw a figure was on the invoice.

            The search field is `<Input>` rather than a bare `TextInput`: this
            one is inside a sheet's own gutter with a label above it, which is
            precisely the case `<Input>` is for and the statement header's bare
            field is not.
          */}
          <Input
            hint="Or swipe through them."
            label="What kind of job"
            onChangeText={setServiceQuery}
            placeholder="Plumbing, wiring, internet…"
            value={serviceQuery}
          />

          {serviceCards.length === 0 ? (
            <Text variant="muted">
              No trade matches that word. Clear the box to see all of them.
            </Text>
          ) : (
            <ServiceCarousel
              cards={serviceCards}
              onSelect={(category) =>
                setDraft((prev) => ({
                  ...prev,
                  category: category as MaintenanceCategory,
                }))
              }
              selectedId={suggestedCategory}
            />
          )}

          {/*
            The problem, said once — spoken by default.

            Owner's call, 2026-09-02: audio takes first priority, the typed box
            hides behind a button, and pressing that button turns it *into* the
            field while the recorder collapses to a button in its place. So the
            two are one control with two faces, and the sheet is never asking for
            the same sentence twice.

            `LinearTransition` on the container is what makes the swap read as
            one thing growing and another shrinking rather than as a re-render:
            the height change is animated on the UI thread, and the two halves
            cross-fade through `entering` / `exiting`. Reanimated is already
            here for the deck above.
          */}
          <Animated.View className="gap-2" layout={LinearTransition.duration(220)}>
            {problemMode === "speak" ? (
              <Animated.View
                entering={FadeIn.duration(160)}
                exiting={FadeOut.duration(120)}
                key="speak"
              >
                <VoiceNoteRecorder
                  disabled={busy}
                  note={voiceNote}
                  onChange={setVoiceNote}
                />

                <Pressable
                  accessibilityLabel="Type the problem instead"
                  accessibilityRole="button"
                  className="mt-2 flex-row items-center justify-center gap-2 rounded-2xl border border-border py-3 active:opacity-70"
                  onPress={() => setProblemMode("type")}
                >
                  <Ionicons color={colors.mutedForeground} name="create-outline" size={16} />
                  <Text className="text-sm font-semibold text-muted-foreground">
                    Type it instead
                  </Text>
                </Pressable>
              </Animated.View>
            ) : (
              <Animated.View
                entering={FadeIn.duration(160)}
                exiting={FadeOut.duration(120)}
                key="type"
              >
                <Input
                  autoFocus
                  hint="Plain language. We read it and fill the rest in."
                  label="The problem"
                  multiline
                  onChangeText={(problem) => setDraft((prev) => ({ ...prev, problem }))}
                  placeholder="The tap in room 204 has been leaking since Tuesday"
                  style={{ height: 96 }}
                  value={draft.problem}
                />

                <Pressable
                  accessibilityLabel="Speak the problem instead"
                  accessibilityRole="button"
                  className="mt-2 flex-row items-center justify-center gap-2 rounded-2xl border border-primary bg-brand-soft py-3 active:opacity-70"
                  onPress={() => setProblemMode("speak")}
                >
                  <Ionicons color={colors.primary} name="mic" size={16} />
                  <Text className="text-sm font-semibold text-primary">
                    Speak the problem
                  </Text>
                </Pressable>
              </Animated.View>
            )}
          </Animated.View>

          {suggestions.length > 0 ? (
            <View className="gap-2 rounded-xl border border-primary/30 bg-brand-soft p-3">
              <View className="flex-row items-center gap-2">
                <Ionicons color={colors.primary} name="sparkles-outline" size={14} />
                <Text className="text-primary" variant="label">
                  Sounds like a job for
                </Text>
              </View>
              <View className="flex-row flex-wrap gap-2">
                {suggestions.map((suggestion) => (
                  <Chip
                    key={suggestion.role}
                    label={providerRoleLabel(suggestion.role)}
                    onPress={() =>
                      setDraft((prev) => ({ ...prev, category: suggestion.category }))
                    }
                    tone={suggestedCategory === suggestion.category ? "brand" : "neutral"}
                  />
                ))}
              </View>
            </View>
          ) : null}

          {/*
            Four buttons, not a dropdown.

            A `<Select>` hid the whole scale behind one line of text, so choosing
            "how bad is this" meant opening a sheet inside a sheet to see what
            the options even were. Four is comfortably inside a phone's width and
            the answer is a single tap on something already visible — and the
            four together *are* the scale, which is the part a dropdown cannot
            show.

            Urgency words in the typed problem still move it on their own; a tap
            is an override, and `suggestedPriority` reads the draft first.
          */}
          <View className="gap-2">
            <Text variant="label">How urgent</Text>
            <View className="flex-row gap-2">
              {PRIORITY_OPTIONS.map((option) => {
                const active = suggestedPriority === option.value;

                return (
                  <Pressable
                    accessibilityLabel={`${option.label}. ${option.description}`}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    className={`flex-1 items-center rounded-2xl border py-2.5 active:opacity-70 ${
                      active ? "border-primary bg-brand-soft" : "border-border bg-card"
                    }`}
                    key={option.value}
                    onPress={() =>
                      setDraft((prev) => ({ ...prev, priority: option.value }))
                    }
                  >
                    <Text
                      className={`text-xs font-bold ${
                        active ? "text-primary" : "text-foreground"
                      }`}
                    >
                      {option.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <Text variant="caption">
              {PRIORITY_OPTIONS.find((option) => option.value === suggestedPriority)
                ?.description ?? "Pick one."}
            </Text>
          </View>

          {/*
            No "Where" field and no provider picker here, both removed on
            2026-09-02.

            **Where** was free text somebody had to type twice — the room number
            is the first thing anybody says out loud in the recording, and asking
            for it again in a box was the sheet not trusting its own headline
            feature. The recorder's own hint asks for it.

            **The provider** moved to the request itself, where `Open` now has an
            "Assign" row. Choosing a contractor at the moment of raising a job is
            a decision about somebody's availability that a warden reporting a
            leak has no way to make, and it made the raise sheet twice as long
            for a field most requests left blank.
          */}
        </View>
      </Sheet>

      {/* ------------------------------------------------------------------ */}
      {/* Call-out charges                                                   */}
      {/* ------------------------------------------------------------------ */}
      {/*
        Read-only. The minimum fee per trade is fixed by the platform, not by the
        hostel — a warden or owner who could lower it could approve any job by
        first making it look cheap. The server still answers all eleven trades.
      */}
      <Sheet
        onClose={() => setChargesOpen(false)}
        open={chargesOpen}
        title="Call-out charges"
      >
        <View className="gap-3 pb-2">
          <Text variant="caption">
            Minimum fee per trade, set by HostelPalika. Shown before a job is
            raised — never added to an invoice.
          </Text>

          <Card padding="px-4 py-1">
            {MAINTENANCE_CATEGORIES.map((category, index) => {
              const amount = minimumChargeFor(charges, category);

              return (
                <View key={category}>
                  {index > 0 ? <RowDivider inset /> : null}
                  <ListRow
                    left={
                      <Image
                        accessibilityIgnoresInvertColors
                        contentFit="contain"
                        source={{ uri: tradeArtUri(category) }}
                        style={{ height: 32, width: 32 }}
                        transition={0}
                      />
                    }
                    right={
                      <Text className="font-semibold text-foreground">
                        {amount === null ? "—" : formatMoney(amount)}
                      </Text>
                    }
                    title={humanizeEnum(category)}
                  />
                </View>
              );
            })}
          </Card>
        </View>
      </Sheet>

      {/* ------------------------------------------------------------------ */}
      {/* Confirm the charge                                                 */}
      {/* ------------------------------------------------------------------ */}
      {/*
        The last screen before the hostel owes somebody money.

        Owner's sketch: after Raise, a confirmation showing the default minimum
        charge for that service, which the person either accepts or declines.
        Two things it deliberately does **not** do:

        - It does not send the figure to the server. `minimumCharges` is the
          platform's floor for the trade, not a line on an invoice; what the job actually costs is recorded
          on the request as a cost note when somebody knows it. Posting a quote
          here would be inventing a number nobody has agreed to yet.
        - It does not block a hostel that has priced nothing. The unpriced case
          is the normal first state, and refusing to raise a request until the
          owner has filled in a rate card for eleven trades would make an
          emergency plumber wait on an admin screen.

        `Decline` goes back to the sheet with the draft intact, rather than
        throwing the request away — declining a *charge* is not abandoning the
        job, it is going back to pick a different trade or a different provider.
      */}
      <Sheet
        footer={
          <View className="flex-row gap-2">
            <Button
              className="flex-1"
              disabled={busy}
              label="Decline"
              onPress={() => setConfirming(false)}
              variant="outline"
            />
            <Button
              className="flex-1"
              label="Accept and raise"
              loading={busy}
              onPress={() => void raise()}
            />
          </View>
        }
        onClose={() => setConfirming(false)}
        open={confirming}
        title="What this will cost"
      >
        <View className="gap-4 pb-2">
          <View className="items-center gap-2 rounded-3xl border border-border bg-card px-4 py-6">
            {/* The same drawing as the deck card they picked, so the confirm
                step is visibly about that card and not a generic dialog. */}
            <Image
              accessibilityIgnoresInvertColors
              contentFit="contain"
              source={{ uri: tradeArtUri(suggestedCategory ?? "OTHER") }}
              style={{ height: 72, width: 72 }}
              transition={0}
            />

            <Text variant="subtitle">{humanizeEnum(suggestedCategory ?? "OTHER")}</Text>

            {quotedCharge === null ? (
              <>
                <Text className="text-center" variant="muted">
                  No call-out charge is set for this trade.
                </Text>
              </>
            ) : (
              <>
                <Text className="text-2xl font-bold text-foreground">
                  {formatMoney(quotedCharge)}
                </Text>
                <Text className="text-center" variant="caption">
                  The minimum fee for this job. The real cost depends on the work
                  and is recorded when it is known.
                </Text>
              </>
            )}
          </View>

          <View className="gap-1 rounded-xl border border-border px-3 py-2.5">
            <Text variant="label">
              {titleForRequest(draft.problem, suggestedCategory)}
            </Text>
            {voiceNote ? (
              <View className="flex-row items-center gap-1.5 pb-0.5">
                <Ionicons color={colors.primary} name="mic" size={12} />
                <Text className="text-xs font-semibold text-primary">
                  {`Voice note · ${formatDuration(voiceNote.durationMs)}`}
                </Text>
              </View>
            ) : null}
            <Text variant="caption">
              {`${humanizeEnum(suggestedPriority ?? "MEDIUM")} priority · sent to every ${humanizeEnum(suggestedCategory ?? "OTHER").toLowerCase()} provider, first to accept takes it`}
            </Text>
          </View>
        </View>
      </Sheet>

      {/* ------------------------------------------------------------------ */}
      {/* One request                                                        */}
      {/* ------------------------------------------------------------------ */}
      <Sheet
        footer={
          <Button label="Apply status" loading={busy} onPress={() => void applyStatus()} />
        }
        onClose={() => setOpen(null)}
        open={open !== null}
        title={open?.title ?? ""}
      >
        {open ? (
          <View className="gap-4 pb-2">
            <View className="gap-2">
              <View className="flex-row flex-wrap gap-2">
                <StatusPill status={open.status} />
                <Badge
                  label={humanizeEnum(open.priority)}
                  tone={PRIORITY_TONE[open.priority] ?? "neutral"}
                />
                <Chip icon="construct-outline" label={humanizeEnum(open.category)} />
              </View>
              {open.description ? <Text variant="muted">{open.description}</Text> : null}
              {/* Under the typed description, because it is the same statement
                  said properly. Absent when the job was raised without one. */}
              {open.voiceNoteAssetId ? (
                <VoiceNotePlayer assetId={open.voiceNoteAssetId} />
              ) : null}
              {open.costNote ? (
                <Text variant="caption">{`Cost note: ${open.costNote}`}</Text>
              ) : null}
            </View>

            {/*
              Assigning, which used to happen on the raise sheet.

              It moved here on 2026-09-02 because choosing a contractor is a
              decision about somebody's availability, and the person reporting a
              leak is not the person who can make it. It is also the step that
              makes the recording worth having: an unassigned request appears in
              no provider's job list, so nothing plays it.

              Once only — the server refuses a second assignment — so a request
              that already has somebody shows who, and no way to change it.
            */}
            {open.status !== "CANCELLED" && open.status !== "COMPLETED" ? (
              <View className="gap-2 border-t border-border pt-3">
                <Text variant="label">Who is coming</Text>

                {providerFor(open.providerId) ? (
                  <View className="flex-row flex-wrap gap-2">
                    <Chip
                      icon="person-outline"
                      label={providerFor(open.providerId)?.fullName ?? "Assigned"}
                      tone="brand"
                    />
                    <Text variant="caption">
                      Already assigned. Cancel and raise a new request to change
                      who is coming.
                    </Text>
                  </View>
                ) : assignableProviders.length === 0 ? (
                  <Text variant="muted">
                    No approved provider matches this trade yet. Call somebody
                    yourself and mark it contacted below.
                  </Text>
                ) : (
                  <View className="flex-row flex-wrap gap-2">
                    {assignableProviders.map((provider) => (
                      <Chip
                        busy={assigning === provider.id}
                        icon="person-add-outline"
                        key={provider.id}
                        label={`${provider.fullName} · ${provider.area}`}
                        onPress={() => void assignProvider(provider.id)}
                      />
                    ))}
                  </View>
                )}
              </View>
            ) : null}

            <View className="gap-2 border-t border-border pt-3">
              <Text variant="label">Move it on</Text>
              <Select
                label="Status"
                onChange={setStatusDraft}
                options={STATUS_OPTIONS}
                value={statusDraft}
              />

              {statusDraft === "SCHEDULED" ? (
                <>
                  <Input
                    keyboardType="numbers-and-punctuation"
                    label="Coming on"
                    onChangeText={setScheduledOn}
                    placeholder="YYYY-MM-DD"
                    value={scheduledOn}
                  />
                  <View className="flex-row flex-wrap gap-2">
                    <Chip label="Today" onPress={() => setScheduledOn(dayInputFromNow(0))} />
                    <Chip
                      label="Tomorrow"
                      onPress={() => setScheduledOn(dayInputFromNow(1))}
                    />
                    <Chip
                      label="In 3 days"
                      onPress={() => setScheduledOn(dayInputFromNow(3))}
                    />
                  </View>
                </>
              ) : null}

              <Input
                hint="Kept on the history entry, so “why was this cancelled” has an answer."
                label="Note"
                onChangeText={setStatusNote}
                placeholder="Plumber came, part on order"
                value={statusNote}
              />

              <Input
                keyboardType="numbers-and-punctuation"
                label="Cost note"
                onChangeText={setCostNote}
                placeholder="NPR 1,200 including the part"
                value={costNote}
              />
            </View>

            <View className="gap-2 border-t border-border pt-3">
              <SectionHeader
                subtitle={`${open.comments.length} note(s), ${open.history.length} change(s)`}
                title="Thread"
              />

              {open.comments.map((entry) => (
                <View className="gap-1 rounded-xl border border-border p-3" key={entry.id}>
                  <View className="flex-row items-center justify-between gap-2">
                    <Badge
                      label={entry.visibility === "INTERNAL" ? "Internal" : "For the provider"}
                      tone={entry.visibility === "INTERNAL" ? "neutral" : "info"}
                    />
                    <Text variant="caption">{dates.dateTime(entry.createdAt)}</Text>
                  </View>
                  <Text>{entry.message}</Text>
                </View>
              ))}

              {open.history.map((entry) => (
                <Text key={entry.id} variant="caption">
                  {`${dates.dateTime(entry.createdAt)} — ${humanizeEnum(entry.previousStatus)} → ${humanizeEnum(entry.nextStatus)}${entry.note ? `: ${entry.note}` : ""}`}
                </Text>
              ))}

              <Input
                label="Add a note"
                multiline
                onChangeText={setComment}
                placeholder="What happened"
                style={{ height: 72 }}
                value={comment}
              />

              <View className="flex-row flex-wrap gap-2">
                <Chip
                  icon="lock-closed-outline"
                  label="Internal"
                  onPress={() => setCommentInternal(true)}
                  tone={commentInternal ? "brand" : "neutral"}
                />
                <Chip
                  icon="share-outline"
                  label="For the provider"
                  onPress={() => setCommentInternal(false)}
                  tone={commentInternal ? "neutral" : "brand"}
                />
              </View>

              <Button
                disabled={comment.trim().length === 0}
                label="Add the note"
                loading={busy}
                onPress={() => void addComment()}
                size="sm"
                variant="outline"
              />
            </View>
          </View>
        ) : null}
      </Sheet>

      {/* ------------------------------------------------------------------ */}
      {/* Providers                                                          */}
      {/* ------------------------------------------------------------------ */}
      <Sheet
        onClose={() => setProvidersOpen(false)}
        open={providersOpen}
        title="Approved providers"
      >
        <View className="gap-3 pb-2">
          <Text variant="caption">
            Vetted by the platform, and their phone numbers are visible to hostel
            staff only — the public directory hides them so nobody is cold-called.
          </Text>

          {providers.length === 0 ? (
            <Text variant="muted">No approved providers cover your area yet.</Text>
          ) : (
            providers.map((provider) => (
              <View className="gap-2 rounded-xl border border-border p-3" key={provider.id}>
                <View className="flex-row items-start justify-between gap-2">
                  <View className="flex-1">
                    <Text variant="label">{provider.fullName}</Text>
                    <Text variant="caption">
                      {`${providerRoleLabel(provider.category)} · ${provider.area}, ${provider.city}`}
                    </Text>
                  </View>
                  {provider.ratingSummary.totalReviews > 0 ? (
                    <Badge
                      label={`${provider.ratingSummary.averageRating.toFixed(1)} ★`}
                      tone="success"
                    />
                  ) : null}
                </View>

                {provider.availability ? (
                  <Text variant="caption">{provider.availability}</Text>
                ) : null}

                <ScrollView
                  contentContainerClassName="gap-2"
                  horizontal
                  showsHorizontalScrollIndicator={false}
                >
                  {provider.phone ? (
                    <Chip
                      icon="call-outline"
                      label={provider.phone}
                      onPress={() => void Linking.openURL(`tel:${provider.phone}`)}
                      tone="brand"
                    />
                  ) : null}
                  {provider.categories.map((role) => (
                    <Chip key={role} label={providerRoleLabel(role)} />
                  ))}
                </ScrollView>
              </View>
            ))
          )}
        </View>
      </Sheet>
    </Screen>
  );
}

/**
 * One request in the queue: the trade's drawing, what and where, who is on it.
 *
 * The whole card opens the request sheet. It used to end in a full-width Open
 * button and carry five chips, so every card was the same height of controls
 * and the title was the smallest thing on it. Low and medium priority are the
 * normal case and are not drawn; only High and Urgent earn a badge.
 */
function RequestRow({
  onOpen,
  provider,
  request,
}: {
  onOpen: () => void;
  provider: { fullName: string; phone?: string | null } | null;
  request: ManagedMaintenanceRequest;
}) {
  const dates = useDates();
  const { colors } = useAppTheme();
  const loud = request.priority === "HIGH" || request.priority === "URGENT";
  const when = request.completedAt
    ? `Done ${dates.date(request.completedAt)}`
    : request.scheduledFor
      ? `Booked for ${dates.date(request.scheduledFor)}`
      : `Raised ${dates.ago(request.createdAt)}`;

  return (
    <Pressable
      accessibilityLabel={`${request.title}. ${humanizeEnum(request.status)}`}
      accessibilityRole="button"
      className="active:opacity-70"
      onPress={onOpen}
    >
      <Card className="gap-3" padding="p-3">
        <View className="flex-row items-start gap-3">
          <Image
            accessibilityIgnoresInvertColors
            contentFit="contain"
            source={{ uri: tradeArtUri(request.category) }}
            style={{ height: 44, width: 44 }}
            transition={0}
          />
          <View className="flex-1 gap-0.5">
            <View className="flex-row items-start gap-2">
              <Text
                className="flex-1 font-semibold text-foreground"
                numberOfLines={1}
                style={{ fontSize: 15 }}
              >
                {request.title}
              </Text>
              <StatusPill status={request.status} />
            </View>
            <Text numberOfLines={1} variant="caption">
              {[humanizeEnum(request.category), request.location].filter(Boolean).join(" · ")}
            </Text>
            {request.description && request.description !== request.title ? (
              <Text className="mt-1" numberOfLines={2} variant="muted">
                {request.description}
              </Text>
            ) : null}
          </View>
        </View>

        {provider ? (
          <View className="flex-row items-center gap-2 rounded-xl bg-muted px-3 py-2">
            <Ionicons color={colors.mutedForeground} name="person-circle-outline" size={18} />
            <Text className="flex-1" numberOfLines={1} variant="label">
              {provider.fullName}
            </Text>
            {provider.phone ? (
              <Pressable
                accessibilityLabel={`Call ${provider.fullName}`}
                accessibilityRole="button"
                className="h-8 w-8 items-center justify-center rounded-full bg-brand-soft active:opacity-70"
                hitSlop={6}
                onPress={() => void Linking.openURL(`tel:${provider.phone}`)}
              >
                <Ionicons color={colors.primary} name="call" size={15} />
              </Pressable>
            ) : null}
          </View>
        ) : null}

        <View className="flex-row items-center gap-3 border-t border-border pt-2.5">
          {loud ? (
            <Badge
              label={humanizeEnum(request.priority)}
              tone={PRIORITY_TONE[request.priority] ?? "warning"}
            />
          ) : null}
          {request.voiceNoteAssetId ? (
            <Ionicons color={colors.primary} name="mic" size={14} />
          ) : null}
          {request.comments.length > 0 ? (
            <View className="flex-row items-center gap-1">
              <Ionicons color={colors.mutedForeground} name="chatbubble-outline" size={13} />
              <Text variant="caption">{request.comments.length}</Text>
            </View>
          ) : null}
          <Text className="flex-1 text-right" numberOfLines={1} variant="caption">
            {when}
          </Text>
        </View>
      </Card>
    </Pressable>
  );
}
