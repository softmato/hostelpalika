import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import Animated, { FadeIn, FadeOut, LinearTransition } from "react-native-reanimated";

import { PhotoCapture } from "@/components/photo-capture";
import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Glyph, type GlyphName } from "@/components/ui/glyph";
import { Input } from "@/components/ui/input";
import { Grid } from "@/components/ui/layout";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { VoiceNoteRecorder, type VoiceNote } from "@/components/voice-note-recorder";
import { useAppTheme } from "@/hooks/use-app-theme";
import { readApiError } from "@/lib/api-contract";
import {
  COMPLAINT_CATEGORY_OPTIONS,
  complaintDescription,
  type ComplaintDraft,
  type ComplaintErrors,
  hasComplaintErrors,
  MAX_COMPLAINT_ATTACHMENTS,
  validateComplaint,
} from "@/lib/complaints";
import {
  type ComplaintCategory,
} from "@/lib/complaints-api";
import { newClientRequestId } from "@/lib/expenses";
import { sendOrQueue } from "@/lib/offline-writes";
import { toastError, toastSuccess } from "@/lib/toast";
import { uploadAsset } from "@/lib/uploads";

/**
 * Raising one.
 *
 * ## The screen is a camera with a question above it
 *
 * It used to be a form: a category picker, a title, a four-line description box
 * and a dashed square that opened the photo library. Five fields, two of them
 * mandatory, to say that the shower is broken — and the mandatory ones were the
 * two nobody has an answer to. A title is a thing a form wants; a person
 * standing in a flooded bathroom has a photograph and a sentence.
 *
 * So what is left is:
 *
 * 1. **What is this about** — eight tiles, one tap, no sheet. It is the only
 *    thing the resident knows better than we do, and it decides which admin
 *    sees the complaint first.
 * 2. **The camera**, already running. See `<PhotoCapture>` for why it is live
 *    rather than behind an "Add photo" button.
 * 3. **Their voice**, by default. Holding the mic and saying "the tap in 204
 *    has been running since Tuesday and the floor is soaked" takes eight
 *    seconds and carries what four lines of typing would not. Typing is still
 *    there — one tap away, and the same control underneath.
 *
 * The title is gone entirely; the server derives one from the first line of
 * whatever came in, or from the category when nothing did. See
 * `complaint-title.ts`.
 *
 * ## Photos upload on pick, not on submit
 *
 * Each picture runs the full presign → PUT → complete pipeline the moment it is
 * taken and the screen keeps the returned `assetId`. Two reasons: an asset that
 * never *completes* is a reservation the hostel cannot open, so the completion
 * has to be visible before the complaint references it; and uploading four
 * photos inside the submit handler makes the one tap that matters take thirty
 * seconds with nothing to show for it.
 *
 * The **recording** goes the other way — it is uploaded on submit, like the
 * maintenance one, because re-recording is what people do and every discarded
 * take would otherwise be an orphaned asset nothing ever collects.
 *
 * Progress is not drawn here — `uploadAsset` registers with the queue that the
 * always-mounted `<UploadToaster />` renders. The thumbnails are the *local*
 * files, which need no auth and no round trip.
 *
 * ## Anonymous hides the name from staff, not from the record
 *
 * `isAnonymous` nulls `residentId` in the *admin's* serialization only, and
 * `auditComplaintAction` still writes `actorId` on creation. The complaint is
 * also still the resident's own in their own list. The row's caption says all
 * three, rather than implying untraceability the server does not provide.
 */

type PickedAttachment = {
  assetId: string;
  /** The on-device file, for the thumbnail. */
  uri: string;
};

export default function NewComplaintScreen() {
  const { colors } = useAppTheme();
  const [category, setCategory] = useState<ComplaintCategory>("MAINTENANCE");
  const [description, setDescription] = useState("");
  const [mode, setMode] = useState<"speak" | "type">("speak");
  const [voiceNote, setVoiceNote] = useState<VoiceNote | null>(null);
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [attachments, setAttachments] = useState<PickedAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // One id per form, so a send that waited offline files once.
  const requestId = useRef(newClientRequestId());
  const [errors, setErrors] = useState<ComplaintErrors>({});

  /**
   * Uploads one picture and keeps the id, whether it came from the shutter or
   * from the library. Both paths are the same file with the same destination,
   * so they are one function — the only difference is who produced the uri.
   *
   * ## The type is carried, never assumed
   *
   * `mimeType` is passed through rather than filled in here. R2 signs the
   * declared content type into the presigned URL, and `/files/{id}/complete`
   * then reads the stored object back and refuses it if the bytes disagree with
   * what was declared — so a PNG out of the gallery announced as `image/jpeg`
   * uploads fine and then fails at the last step with "file contents do not
   * match type", which is a failure with nothing left to retry.
   *
   * Only the shutter states a type, because only the shutter knows one:
   * `takePictureAsync` writes JPEG. The picker hands back the real type, and
   * where it does not, `resolveMimeType` reads the extension off the uri —
   * which is exactly the fallback it exists for.
   */
  const attach = useCallback(
    async (asset: {
      fileName?: string;
      fileSize?: number;
      mimeType?: string;
      uri: string;
    }) => {
      setUploading(true);

      try {
        /*
         * `GENERIC`, not `PAYMENT_PROOF`: the presign route refuses a financial
         * asset it cannot tenant-scope, and a photo of a broken tap is not money
         * evidence.
         */
        const assetId = await uploadAsset(
          {
            fileName: asset.fileName,
            fileSize: asset.fileSize,
            mimeType: asset.mimeType,
            uri: asset.uri,
          },
          { kind: "GENERIC", label: "Complaint photo" },
        );

        setAttachments((current) => [...current, { assetId, uri: asset.uri }]);
      } catch (caught) {
        toastError("That photo did not attach", readApiError(caught));
      } finally {
        setUploading(false);
      }
    },
    [],
  );

  const pickFromLibrary = useCallback(async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();

    if (!permission.granted) {
      toastError("Permission needed", "Allow photo access to attach one you have.");
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.8,
    });
    const picked = result.canceled ? null : result.assets[0];

    if (picked) {
      await attach({
        fileName: picked.fileName ?? undefined,
        fileSize: picked.fileSize,
        // The picker's own answer. Absent on several Android paths, where
        // `resolveMimeType` falls back to the extension on the uri.
        mimeType: picked.mimeType,
        uri: picked.uri,
      });
    }
  }, [attach]);

  const remove = useCallback((uri: string) => {
    // Local only. The `FileAsset` stays uploaded and simply goes unreferenced —
    // there is no resident-facing delete route, and inventing one by leaving the
    // id out is the honest half of the job.
    setAttachments((current) => current.filter((item) => item.uri !== uri));
  }, []);

  /*
   * Memoised because `submit` closes over it: a fresh object every render is a
   * fresh `submit` every render, which is the footer button re-rendering on
   * every keystroke in the description box.
   */
  const draft: ComplaintDraft = useMemo(
    () => ({
      attachmentCount: attachments.length,
      description,
      hasVoiceNote: voiceNote !== null,
    }),
    [attachments.length, description, voiceNote],
  );

  const submit = useCallback(async () => {
    const found = validateComplaint(draft);

    setErrors(found);

    if (hasComplaintErrors(found)) {
      /* The one blocking case is the words, so put the box in front of them. */
      if (found.description && !voiceNote) {
        setMode("type");
      }

      return;
    }

    setSubmitting(true);

    try {
      /*
       * The recording goes up first, and a failure **stops the complaint**
       * rather than quietly sending it without the thing that was its
       * description. Somebody who just spoke for thirty seconds has to be told
       * it did not go, not discover it when nobody acts on an empty complaint.
       *
       * `COMPLAINT_NOTE`, never `MAINTENANCE_NOTE`: that kind is the one the
       * server widens to an assigned service provider, and a complaint about the
       * kitchen staff must not sit in it. `PRIVATE` is the default and is stated
       * anyway — this is the resident's own voice, naming rooms and people.
       */
      const voiceNoteAssetId = voiceNote
        ? await uploadAsset(
            {
              fileName: `complaint-note-${Date.now()}.m4a`,
              fileSize: undefined,
              mimeType: "audio/x-m4a",
              uri: voiceNote.uri,
            },
            {
              accessLevel: "PRIVATE",
              kind: "COMPLAINT_NOTE",
              label: "Voice note",
            },
          )
        : undefined;

      const outcome = await sendOrQueue("complaint", {
        attachmentAssetIds: attachments.map((item) => item.assetId),
        category,
        clientRequestId: requestId.current,
        // Absent, not empty — `""` is a 422 while a missing field is fine.
        description: complaintDescription(description),
        isAnonymous,
        voiceNoteAssetId,
      });

      if (outcome === "sent") toastSuccess(
        "Sent to your hostel",
        voiceNote
          ? "Your recording went with it. You will see the reply here."
          : "You will see the reply here.",
      );
      // Back to the list rather than into the new complaint: the list is where
      // the resident came from and it now shows the row they just created.
      router.back();
    } catch (caught) {
      toastError("That did not send", readApiError(caught));
    } finally {
      setSubmitting(false);
    }
  }, [attachments, category, description, draft, isAnonymous, voiceNote]);

  return (
    <Screen
      footer={
        <Button
          label="Send to my hostel"
          /* Quieter type than the default. The button is the loudest thing on
             a deliberately calm screen, and it does not need to be shouted —
             it is the only filled control on the page. */
          labelClassName="text-sm font-medium"
          loading={submitting}
          onPress={() => void submit()}
        />
      }
      header={<AppBar showBack title="Raise an issue" />}
      scroll
    >
      <View className="gap-5 pt-1">
        <View className="gap-2">
          <Text variant="label">What is this about?</Text>

          <Grid gap={8} maxColumns={4} minCellWidth={72}>
            {COMPLAINT_CATEGORY_OPTIONS.map((option) => (
              <CategoryTile
                icon={option.icon}
                key={option.value}
                label={option.label}
                onPress={() => setCategory(option.value)}
                selected={category === option.value}
              />
            ))}
          </Grid>

          <Text variant="caption">
            {
              COMPLAINT_CATEGORY_OPTIONS.find((option) => option.value === category)
                ?.description
            }{" "}
            · Decides who at the hostel sees it first.
          </Text>
        </View>

        {/*
          Wider than the page and square rather than landscape.

          `-mx-3` spends most of the screen's `px-5` gutter, and 1:1 is a third
          taller than the camera's own 4:3 — together they are the space the two
          removed paragraphs were using. The viewfinder is the screen's subject,
          and aiming a phone at a leaking pipe through a letterbox is the one
          part of this that is genuinely harder on a small frame.
        */}
        <PhotoCapture
          aspectRatio={1}
          busy={uploading}
          className="-mx-3"
          max={MAX_COMPLAINT_ATTACHMENTS}
          onCapture={(photo) =>
            // The one caller that may state a type: `takePictureAsync` writes JPEG.
            void attach({
              fileName: `complaint-${Date.now()}.jpg`,
              mimeType: "image/jpeg",
              uri: photo.uri,
            })
          }
          onPickFromLibrary={() => void pickFromLibrary()}
          onRemove={remove}
          photos={attachments.map((attachment) => ({ uri: attachment.uri }))}
        />

        {errors.attachmentCount ? (
          <Text className="text-destructive" variant="caption">
            {errors.attachmentCount}
          </Text>
        ) : null}

        {/*
          Speak or type — one control with two faces, never both at once, so the
          screen is never asking for the same sentence twice. `LinearTransition`
          on the container makes the swap read as one thing growing and the
          other shrinking rather than as a re-render; the halves cross-fade
          through `entering` / `exiting`. Same shape as the maintenance screen,
          deliberately: a resident who has watched a warden raise a job should
          recognise this.
        */}
        <Animated.View className="gap-2" layout={LinearTransition.duration(220)}>
          <Text variant="label">What happened?</Text>

          {mode === "speak" ? (
            <Animated.View
              entering={FadeIn.duration(160)}
              exiting={FadeOut.duration(120)}
              key="speak"
            >
              <VoiceNoteRecorder
                context="complaint"
                disabled={submitting}
                label={null}
                note={voiceNote}
                onChange={setVoiceNote}
                showHint={false}
              />

              <SwapButton
                icon="create"
                label="Type instead"
                onPress={() => setMode("type")}
              />
            </Animated.View>
          ) : (
            <Animated.View
              entering={FadeIn.duration(160)}
              exiting={FadeOut.duration(120)}
              key="type"
            >
              <Input
                autoFocus
                error={errors.description}
                maxLength={4000}
                multiline
                numberOfLines={5}
                onChangeText={setDescription}
                placeholder="When it started, which room, what you have already tried."
                style={{ height: 116, paddingTop: 12, textAlignVertical: "top" }}
                value={description}
              />

              <SwapButton
                icon="mic"
                label={voiceNote ? "Back to recording" : "Say instead"}
                onPress={() => setMode("speak")}
              />
            </Animated.View>
          )}
        </Animated.View>

        {/*
          One line, no explanation under it.

          What the paragraph said is still said — as the accessibility hint, so
          it reaches a screen reader and costs the screen no height. The claim
          it was guarding against is not made anywhere: the row says "without my
          name", not "anonymously", and the complaint still shows as the
          resident's own in their own list.
        */}
        <Pressable
          accessibilityHint="Hostel staff see the complaint without your name. It still appears in your own list, and it is still recorded against your account."
          accessibilityRole="switch"
          accessibilityState={{ checked: isAnonymous }}
          className="flex-row items-center gap-3 rounded-2xl border border-border bg-card px-3 py-3 active:opacity-70"
          onPress={() => setIsAnonymous((value) => !value)}
        >
          <Glyph
            color={isAnonymous ? colors.primary : colors.mutedForeground}
            name={isAnonymous ? "checkbox" : "square"} variant={isAnonymous ? "solid" : "line"}
            size={22}
          />

          <Text className="flex-1" variant="label">
            Send this without my name
          </Text>
        </Pressable>
      </View>
    </Screen>
  );
}

/**
 * One of the eight.
 *
 * A tinted glyph over a short label — the shape every screen in
 * `ui_inspiration_folder/app_recordings` uses for a menu of destinations, and
 * the reason the category is a grid here instead of the `<Select>` it was. Eight
 * tiles are read in one glance and chosen in one tap; the picker was a tap to
 * open, a scroll and a tap to close.
 *
 * Selection is the filled brand tile, which is the only place colour appears on
 * this screen apart from the send button.
 */
function CategoryTile({
  icon,
  label,
  onPress,
  selected,
}: {
  icon: GlyphName;
  label: string;
  onPress: () => void;
  selected: boolean;
}) {
  const { colors } = useAppTheme();

  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      className={`items-center gap-1.5 rounded-2xl border px-1 py-3 active:opacity-70 ${
        selected ? "border-primary bg-primary" : "border-border bg-card"
      }`}
      onPress={onPress}
    >
      <Glyph
        color={selected ? colors.primaryForeground : colors.mutedForeground}
        name={icon}
        size={20}
      />
      {/*
        `variant={null}` because this states its own size: a variant's own
        `text-base` beats an appended size class in NativeWind's ordering, which
        is how eight tiles end up with 16pt labels that do not fit them.
      */}
      <Text
        className={`text-[11px] font-semibold ${
          selected ? "text-primary-foreground" : "text-foreground"
        }`}
        numberOfLines={1}
        variant={null}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * The quiet control that swaps the mic for the keyboard, and back.
 *
 * Two words inside the box rather than a bare glyph. A pencil on its own is
 * only obvious once you already know what it does, and this is the control that
 * rescues anybody who cannot or will not record — the one place on the screen
 * where guessing wrong means giving up. Short enough to stay a control rather
 * than a sentence.
 */
function SwapButton({
  icon,
  label,
  onPress,
}: {
  icon: GlyphName;
  label: string;
  onPress: () => void;
}) {
  const { colors } = useAppTheme();

  return (
    <Pressable
      accessibilityRole="button"
      className="mt-2 h-11 flex-row items-center justify-center gap-2 rounded-2xl border border-border active:opacity-70"
      onPress={onPress}
    >
      <Glyph color={colors.mutedForeground} name={icon} size={16} />
      <Text className="text-sm font-medium text-muted-foreground" variant={null}>
        {label}
      </Text>
    </Pressable>
  );
}
