"use client";

import { ROOM_TYPE_OPTIONS } from "@hostel/shared/constants/room-types";
import { BedDouble, ImagePlus, Loader2, Trash2 } from "lucide-react";
import {
  memo,
  useCallback,
  useMemo,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";

import {
  currency,
  EmptyState,
  Input,
  Panel,
  Select,
  StatusBadge,
} from "@/app/_components/shared-ui";
import { BusyForm, SubmitButton } from "@/app/_components/busy-form";
import { useMediaViewer } from "@/components/media-viewer";
import { Button } from "@/components/ui/button";
import { browserApi } from "@/lib/browser-api";
import {
  photosOfKind,
  resolveHostelPhotoUrls,
  type HostelPhoto,
} from "@/lib/hostel-photos";
import { acceptAttribute } from "@/lib/uploads/accepts";
import { uploadFiles } from "@/lib/uploads/uploader";
import { hostelAdminEndpoints } from "@/lib/hostel-admin-endpoints";
import { usePortalResource } from "@/lib/portal-query";
import {
  field,
  Message,
  numberField,
  PageHeader,
  RoomConfiguration,
} from "./core-portal-shared";

const ROOM_TYPES = ROOM_TYPE_OPTIONS;

/** Mirrors PHOTO_LIMITS.ROOM in hostel-profile.service — counted per room type. */
const ROOM_PHOTO_LIMIT = 10;

/**
 * A file the admin just picked, rendered from a local object URL so the
 * gallery fills in on click. It blurs under a spinner until its upload lands.
 */
type PendingPhoto = {
  id: string;
  previewUrl: string;
  uploaded?: boolean;
};

/**
 * Rooms are tracked as counts per type, not as individual records. Each row is
 * "how many rooms of this type, how many beds each, how many beds free right
 * now" — the same numbers the owner gave at registration, and the same ones
 * that admitting or moving out a resident adjusts.
 *
 * Photos hang off the same room type: up to ten shots the public listing shows
 * when a visitor opens that room type, which also stand in as fallback imagery
 * elsewhere when the hostel has nothing better uploaded.
 */
export const HostelAdminRoomsPageContent = memo(function HostelAdminRoomsPageContent() {
  const { open: openViewer } = useMediaViewer();
  const [pendingByRoom, setPendingByRoom] = useState<Record<string, PendingPhoto[]>>({});
  // Photos whose delete is in flight — mirrored on the upload treatment, so a
  // removal blurs under a spinner instead of sitting crisp until the round trip.
  const [deletingIds, setDeletingIds] = useState<string[]>([]);
  const [uploadingFor, setUploadingFor] = useState("");
  const [actionMessage, setActionMessage] = useState("");

  // Same cache entry as the Profile and Fee Plans screens.
  const profileResource = usePortalResource<{
    hostel: { photos?: HostelPhoto[]; roomConfigurations: RoomConfiguration[] };
  }>(hostelAdminEndpoints.profile, { errorMessage: "Could not load room types." });

  const configurations = useMemo(
    () => profileResource.data?.hostel.roomConfigurations ?? [],
    [profileResource.data],
  );
  const photos = useMemo(
    () => profileResource.data?.hostel.photos ?? [],
    [profileResource.data],
  );
  const message = actionMessage || profileResource.message;
  const { refreshAsync: reloadProfile } = profileResource;

  const save = useCallback(
    async (next: RoomConfiguration[], successMessage: string) => {
      try {
        await browserApi(hostelAdminEndpoints.profile, {
          body: JSON.stringify({
            roomConfigurations: next.map((config) => ({
              bedsPerRoom: config.bedsPerRoom,
              mealInclusion: config.mealInclusion ?? "Included",
              monthlyRent: config.monthlyRent,
              rooms: config.rooms,
              roomType: config.roomType,
              vacantBeds: config.vacantBeds,
            })),
          }),
          method: "PATCH",
        });
        setActionMessage(successMessage);
        await reloadProfile();
      } catch (error) {
        setActionMessage(
          error instanceof Error ? error.message : "Could not save room types.",
        );
      }
    },
    [reloadProfile],
  );

  const addRoomType = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const formElement = event.currentTarget;
      const form = new FormData(formElement);
      const roomType = field(form, "roomType");
      const rooms = numberField(form, "rooms") ?? 0;
      const bedsPerRoom = numberField(form, "bedsPerRoom") ?? 1;

      if (configurations.some((config) => config.roomType === roomType)) {
        setActionMessage(`"${roomType}" already exists — edit its counts instead.`);
        return;
      }

      // A brand new room type starts fully vacant; nobody is living in it yet.
      const next = [
        ...configurations,
        {
          bedsPerRoom,
          mealInclusion: "Included",
          // Unpriced until the rate card prices it. Zero is not a rent, and
          // `listedRoomRates` reads a zero as "not priced" for exactly this
          // reason — billing somebody nothing is the failure this guards.
          monthlyRent: 0,
          rooms,
          roomType,
          vacantBeds: rooms * bedsPerRoom,
        },
      ];

      formElement.reset();
      await save(next, `Added ${roomType}.`);
    },
    [configurations, save],
  );

  const updateRoomType = useCallback(
    async (roomType: string, event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const rooms = numberField(form, "rooms") ?? 0;
      const bedsPerRoom = numberField(form, "bedsPerRoom") ?? 1;
      const totalBeds = rooms * bedsPerRoom;
      const vacantBeds = numberField(form, "vacantBeds") ?? 0;

      if (vacantBeds > totalBeds) {
        setActionMessage(
          `Vacant beds cannot exceed ${totalBeds} — that is all this room type has.`,
        );
        return;
      }

      const next = configurations.map((config) =>
        config.roomType === roomType
          ? {
              ...config,
              bedsPerRoom,
              // Carried through, never read from the form — there is no rent
              // field on this page any more. The server drops it anyway once a
              // rate card exists; this keeps a hostel that has no card yet from
              // losing the price it listed at signup.
              monthlyRent: config.monthlyRent,
              rooms,
              vacantBeds,
            }
          : config,
      );

      await save(next, `Updated ${roomType}.`);
    },
    [configurations, save],
  );

  const removeRoomType = useCallback(
    async (roomType: string) => {
      const next = configurations.filter((config) => config.roomType !== roomType);

      await save(next, `Removed ${roomType}.`);
    },
    [configurations, save],
  );

  const uploadRoomPhotos = useCallback(
    async (event: ChangeEvent<HTMLInputElement>, roomType: string, freeSlots: number) => {
      const chosen = Array.from(event.currentTarget.files ?? []);
      event.currentTarget.value = "";
      if (chosen.length === 0) return;

      // Trim to what still fits rather than letting the server reject the tail
      // of the batch one 422 at a time.
      const files = chosen.slice(0, freeSlots);
      const skipped = chosen.length - files.length;

      // Show the picked files straight away, blurred under a spinner, so the
      // gallery reacts to the click instead of to the round trip.
      const pending: PendingPhoto[] = files.map((file) => ({
        id: crypto.randomUUID(),
        previewUrl: URL.createObjectURL(file),
      }));

      setPendingByRoom((prev) => ({ ...prev, [roomType]: pending }));
      setUploadingFor(roomType);
      try {
        let added = 0;

        // One file at a time so each preview sharpens as its own upload lands,
        // rather than the whole batch clearing at once. uploadFiles registers
        // every file with the global upload store, so the always-mounted
        // toaster still shows byte-level progress.
        for (const [index, file] of files.entries()) {
          const [outcome] = await uploadFiles([file], {
            accessLevel: "PUBLIC",
            kind: "image",
            label: `${roomType} photo`,
            scope: `room-photos:${roomType}`,
            // Failures already toast; the summary below covers the successes.
            silent: true,
          });

          if (!outcome?.ok || !outcome.result.assetId) {
            // A file that failed should stop pretending it is on its way.
            setPendingByRoom((prev) => ({
              ...prev,
              [roomType]: (prev[roomType] ?? []).filter(
                (item) => item.id !== pending[index].id,
              ),
            }));
            URL.revokeObjectURL(pending[index].previewUrl);
            continue;
          }

          await browserApi(`${hostelAdminEndpoints.profile}/photos`, {
            body: JSON.stringify({
              alt: roomType,
              fileAssetId: outcome.result.assetId,
              kind: "ROOM",
              roomType,
              // Relative on purpose — see the note in hostel-admin-profile-page.
              url: `/api/v1/files/${outcome.result.assetId}/url`,
            }),
            method: "POST",
          });
          added += 1;

          // Drop the blur — this one is stored, even though the refreshed list
          // has not come back yet.
          setPendingByRoom((prev) => ({
            ...prev,
            [roomType]: (prev[roomType] ?? []).map((item) =>
              item.id === pending[index].id ? { ...item, uploaded: true } : item,
            ),
          }));
        }

        setActionMessage(
          [
            added > 0
              ? `Added ${added} photo(s) to ${roomType}.`
              : `No photos were added to ${roomType}.`,
            skipped > 0
              ? `${skipped} skipped — ${roomType} holds at most ${ROOM_PHOTO_LIMIT} photos.`
              : "",
          ]
            .filter(Boolean)
            .join(" "),
        );
        await reloadProfile();
      } catch (error) {
        setActionMessage(
          error instanceof Error ? error.message : "Could not upload photos.",
        );
      } finally {
        // The stored photos are on screen now, so the local previews can go.
        setPendingByRoom((prev) => {
          const next = { ...prev };
          delete next[roomType];
          return next;
        });
        for (const item of pending) {
          URL.revokeObjectURL(item.previewUrl);
        }
        setUploadingFor("");
      }
    },
    [reloadProfile],
  );

  const deleteRoomPhoto = useCallback(
    async (photoId?: string) => {
      if (!photoId) return;
      setDeletingIds((prev) => (prev.includes(photoId) ? prev : [...prev, photoId]));
      try {
        await browserApi(`${hostelAdminEndpoints.profile}/photos/${photoId}`, {
          method: "DELETE",
        });
        setActionMessage("Photo removed.");
        await reloadProfile();
      } catch (error) {
        setActionMessage(
          error instanceof Error ? error.message : "Could not remove photo.",
        );
      } finally {
        // The refreshed list has dropped it by now; a failed delete gets its
        // photo back sharp and clickable.
        setDeletingIds((prev) => prev.filter((id) => id !== photoId));
      }
    },
    [reloadProfile],
  );

  const totals = configurations.reduce(
    (summary, config) => ({
      beds: summary.beds + config.rooms * config.bedsPerRoom,
      rooms: summary.rooms + config.rooms,
      vacant: summary.vacant + config.vacantBeds,
    }),
    { beds: 0, rooms: 0, vacant: 0 },
  );

  // A type already on the list is edited in place, so it has no business
  // sitting in the "add" dropdown.
  const addableRoomTypes = useMemo(
    () =>
      ROOM_TYPES.filter(
        (type) => !configurations.some((config) => config.roomType === type),
      ),
    [configurations],
  );

  return (
    <div className="mx-auto max-w-[1448px] space-y-6">
      <PageHeader
        description="Room types with their room, bed, and vacancy counts. Registering a resident reduces the vacant count for their room type."
        icon={BedDouble}
        title="Rooms & Beds"
      />
      <Message value={message} />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Panel title="Room Types">
          {configurations.length === 0 ? (
            <EmptyState label="No room types yet. Add one on the right." />
          ) : (
            <>
              <p className="mb-4 text-sm text-muted-foreground">
                {totals.rooms} room(s) · {totals.beds} bed(s) ·{" "}
                <span className="font-semibold text-foreground">
                  {totals.vacant} vacant
                </span>
              </p>
              <div className="space-y-4">
                {configurations.map((config) => {
                  const totalBeds = config.rooms * config.bedsPerRoom;
                  const roomPhotos = photosOfKind(photos, "ROOM", config.roomType);
                  const pending = pendingByRoom[config.roomType] ?? [];
                  // Previews count against the limit while they are in flight.
                  const atPhotoLimit =
                    roomPhotos.length + pending.length >= ROOM_PHOTO_LIMIT;
                  // What the public page falls back to while this room type
                  // has no photos of its own.
                  const fallbackUrl = resolveHostelPhotoUrls(
                    photos,
                    "ROOM",
                    config.roomType,
                  )[0];
                  const uploading = uploadingFor === config.roomType;

                  return (
                    <div
                      className="rounded-lg border border-border p-4"
                      key={config.roomType}
                    >
                      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="font-semibold text-foreground">
                            {config.roomType}
                          </h3>
                          <p className="text-sm text-muted-foreground">
                            {totalBeds - config.vacantBeds} of {totalBeds} bed(s) occupied
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <StatusBadge>
                            {config.vacantBeds === 0
                              ? "FULL"
                              : config.vacantBeds === totalBeds
                                ? "VACANT"
                                : "PARTIAL"}
                          </StatusBadge>
                          <label
                            className={
                              atPhotoLimit || uploading
                                ? "inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-muted-foreground"
                                : "inline-flex cursor-pointer items-center gap-2 rounded-md border border-role-admin px-3 py-1.5 text-xs font-semibold text-role-admin transition hover:bg-role-admin/10"
                            }
                            title={
                              atPhotoLimit
                                ? `This room type already has ${ROOM_PHOTO_LIMIT} photos.`
                                : undefined
                            }
                          >
                            <ImagePlus className="size-4" />
                            {uploading
                              ? "Uploading..."
                              : `Photos (${roomPhotos.length + pending.length}/${ROOM_PHOTO_LIMIT})`}
                            <input
                              accept={acceptAttribute("image")}
                              className="hidden"
                              disabled={uploading || atPhotoLimit}
                              multiple
                              onChange={(event) =>
                                void uploadRoomPhotos(
                                  event,
                                  config.roomType,
                                  ROOM_PHOTO_LIMIT - roomPhotos.length - pending.length,
                                )
                              }
                              type="file"
                            />
                          </label>
                        </div>
                      </div>

                      {/* Always shown, so the card makes plain what a visitor
                          sees for this room type — its own photos, or whatever
                          is standing in for them. */}
                      <div className="mb-4">
                        {roomPhotos.length > 0 || pending.length > 0 ? (
                          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-8">
                            {roomPhotos.map((photo, photoIndex) => {
                              const deleting =
                                photo.id != null && deletingIds.includes(photo.id);

                              return (
                                <div
                                  className="group relative"
                                  key={photo.id ?? photo.url}
                                >
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img
                                    alt={photo.alt || `${config.roomType} photo`}
                                    className={
                                      deleting
                                        ? "h-20 w-full rounded-md border border-border object-cover blur-[2px] brightness-90 transition"
                                        : "h-20 w-full cursor-zoom-in rounded-md border border-border object-cover transition"
                                    }
                                    onClick={() =>
                                      deleting
                                        ? undefined
                                        : openViewer(
                                            roomPhotos.map((item) => ({
                                              src: item.url ?? "",
                                              title: config.roomType,
                                            })),
                                            photoIndex,
                                          )
                                    }
                                    src={photo.url}
                                  />
                                  {deleting ? (
                                    <div className="absolute inset-0 flex items-center justify-center rounded-md bg-black/25">
                                      <Loader2 className="size-5 animate-spin text-white" />
                                    </div>
                                  ) : (
                                    <Button
                                      className="absolute right-1 top-1 size-6 opacity-0 transition group-hover:opacity-100"
                                      onClick={() => void deleteRoomPhoto(photo.id)}
                                      size="icon"
                                      type="button"
                                      variant="destructive"
                                    >
                                      <Trash2 className="size-3" />
                                    </Button>
                                  )}
                                </div>
                              );
                            })}
                            {pending.map((item) => (
                              <div className="relative" key={item.id}>
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  alt=""
                                  className={
                                    item.uploaded
                                      ? "h-20 w-full rounded-md border border-border object-cover transition"
                                      : "h-20 w-full rounded-md border border-border object-cover blur-[2px] brightness-90 transition"
                                  }
                                  src={item.previewUrl}
                                />
                                {item.uploaded ? null : (
                                  <div className="absolute inset-0 flex items-center justify-center rounded-md bg-black/25">
                                    <Loader2 className="size-5 animate-spin text-white" />
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="flex items-center gap-3 rounded-md border border-dashed border-border p-3">
                            {fallbackUrl ? (
                              /* eslint-disable-next-line @next/next/no-img-element */
                              <img
                                alt=""
                                className="h-20 w-28 shrink-0 rounded-md border border-border object-cover opacity-60"
                                src={fallbackUrl}
                              />
                            ) : (
                              <div className="flex h-20 w-28 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
                                <ImagePlus className="size-5 text-muted-foreground" />
                              </div>
                            )}
                            <p className="text-sm text-muted-foreground">
                              No photos for {config.roomType} yet —{" "}
                              {fallbackUrl
                                ? "visitors see this stand-in photo."
                                : "visitors see a stock photo."}{" "}
                              Add up to {ROOM_PHOTO_LIMIT} to show the real room.
                            </p>
                          </div>
                        )}
                      </div>

                      <BusyForm
                        className="space-y-3"
                        onSubmit={(event) => updateRoomType(config.roomType, event)}
                      >
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                          <Input
                            defaultValue={config.rooms}
                            label="Rooms"
                            min="0"
                            name="rooms"
                            required
                            type="number"
                          />
                          <Input
                            defaultValue={config.bedsPerRoom}
                            label="Beds / room"
                            min="1"
                            name="bedsPerRoom"
                            required
                            type="number"
                          />
                          <Input
                            defaultValue={config.vacantBeds}
                            label="Vacant beds"
                            min="0"
                            name="vacantBeds"
                            required
                            type="number"
                          />
                          {/*
                            The rent is a fact here, not a field.

                            It was a second box a person could type a rent into,
                            and that is what this whole page's worst bug was made
                            of: the rate card said one number, this said another,
                            the public listing read this one and billing read the
                            card, and nothing compared them — one hostel
                            advertised 18,000 while invoicing 174,000. The rate
                            card is the single source now and this figure is
                            written from it, so showing it as editable would
                            promise an edit that the next rate change silently
                            undoes.
                          */}
                          <div className="grid content-start gap-1.5">
                            <span className="text-sm font-medium text-foreground">
                              Monthly rent
                            </span>
                            <p className="flex h-10 items-center text-sm font-semibold text-foreground">
                              {config.monthlyRent
                                ? currency(config.monthlyRent)
                                : "Not priced yet"}
                            </p>
                            <span className="text-xs text-muted-foreground">
                              Set on Fees &amp; Payments → Fee Schedule.
                            </span>
                          </div>
                        </div>
                        <div className="flex flex-wrap justify-end gap-2">
                          <button
                            className="h-10 rounded-md border border-border px-4 text-sm font-semibold text-muted-foreground transition hover:text-destructive"
                            onClick={() => removeRoomType(config.roomType)}
                            type="button"
                          >
                            Remove
                          </button>
                          <SubmitButton className="h-10 rounded-md bg-role-admin px-6 text-sm font-semibold text-white transition hover:bg-role-admin/85">
                            Save
                          </SubmitButton>
                        </div>
                      </BusyForm>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </Panel>
        <Panel title="Add Room Type">
          <p className="mb-3 text-sm text-muted-foreground">
            New room types start fully vacant. Vacancy then moves on its own as residents
            are registered and moved out.
          </p>
          <p className="mb-3 text-sm text-muted-foreground">
            Price it afterwards on Fees &amp; Payments → Fee Schedule. Until you do,
            nobody in it can be billed and your public page shows it without a price —
            which is the honest state, and a loud one.
          </p>
          {addableRoomTypes.length === 0 ? (
            <EmptyState label="Every room type is already on your list. Edit one on the left." />
          ) : (
            <BusyForm className="grid gap-3" onSubmit={addRoomType}>
              <Select label="Room type" name="roomType" required>
                <option value="">Select type</option>
                {addableRoomTypes.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </Select>
              <Input label="How many rooms" min="1" name="rooms" required type="number" />
              <Input
                label="Beds per room"
                min="1"
                name="bedsPerRoom"
                required
                type="number"
              />
              <SubmitButton className="h-10 rounded-md bg-role-admin text-sm font-semibold text-white transition hover:bg-role-admin/85">
                Add Room Type
              </SubmitButton>
            </BusyForm>
          )}
        </Panel>
      </div>
    </div>
  );
});
