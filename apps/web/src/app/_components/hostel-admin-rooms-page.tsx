"use client";

import { ROOM_TYPE_OPTIONS } from "@hostel/shared/constants/room-types";
import { BedDouble, DoorOpen, ImagePlus, Loader2, Pencil, Plus, Sparkles, Trash2 } from "@/components/icons";
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
} from "@/app/_components/shared-ui";
import { BusyForm, SubmitButton } from "@/app/_components/busy-form";
import { FloorsPanel } from "@/app/_components/hostel-admin-floors-panel";
import { MetricCard } from "@/app/_components/portal-dashboard-ui";
import { Glyph, type GlyphName } from "@/components/glyph";
import { useMediaViewer } from "@/components/media-viewer";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { cn } from "@/lib/utils";
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

/** Beds taken out of beds there are, as a bar: the card's one graphic. */
function OccupancyBar({ occupied, total }: { occupied: number; total: number }) {
  const share = total > 0 ? Math.round((occupied / total) * 100) : 0;

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between text-[12.5px]">
        <span className="font-semibold text-foreground">
          {occupied}
          <span className="font-normal text-muted-foreground"> / {total} beds taken</span>
        </span>
        <span className="font-semibold text-muted-foreground">{share}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-700 ease-out",
            share >= 100 ? "bg-foreground" : "bg-brand-teal",
          )}
          style={{ width: `${share}%` }}
        />
      </div>
    </div>
  );
}

function Fact({ glyph, children, warn = false }: { children: string; glyph: GlyphName; warn?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium",
        warn ? "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300" : "bg-muted text-foreground",
      )}
    >
      <Glyph className="size-3.5" name={glyph} />
      {children}
    </span>
  );
}

/**
 * Rooms are tracked as counts per type, not as individual records. Each type is
 * "how many rooms, how many beds each, how many beds free right now" — the same
 * numbers the owner gave at registration, and the same ones that admitting or
 * moving out a resident adjusts.
 *
 * The page shows those counts as cards — cover photo, occupancy bar, facts — and
 * keeps every edit in a dialog, so nothing on the page is an open form until the
 * owner asks for one.
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
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [photosFor, setPhotosFor] = useState<string | null>(null);

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

  /** Writes the whole list; `true` when the server took it. */
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
        return true;
      } catch (error) {
        setActionMessage(
          error instanceof Error ? error.message : "Could not save room types.",
        );
        return false;
      }
    },
    [reloadProfile],
  );

  const addRoomType = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
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

      if (await save(next, `Added ${roomType}.`)) setAdding(false);
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
              // field on this page. The rate card is the single source of rent
              // (one hostel once advertised 18,000 while invoicing 174,000
              // because this page had its own box), and the server drops this
              // once a card exists; it only keeps a hostel with no card yet from
              // losing the price it listed at signup.
              monthlyRent: config.monthlyRent,
              rooms,
              vacantBeds,
            }
          : config,
      );

      if (await save(next, `Updated ${roomType}.`)) setEditing(null);
    },
    [configurations, save],
  );

  const removeRoomType = useCallback(
    async (roomType: string) => {
      const next = configurations.filter((config) => config.roomType !== roomType);

      if (await save(next, `Removed ${roomType}.`)) setEditing(null);
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
  const fullShare = totals.beds > 0 ? Math.round(((totals.beds - totals.vacant) / totals.beds) * 100) : 0;

  // A type already on the list is edited in place, so it has no business
  // sitting in the "add" dropdown.
  const addableRoomTypes = useMemo(
    () =>
      ROOM_TYPES.filter(
        (type) => !configurations.some((config) => config.roomType === type),
      ),
    [configurations],
  );

  const editingConfig = configurations.find((config) => config.roomType === editing) ?? null;
  const photosRoomPhotos = photosFor ? photosOfKind(photos, "ROOM", photosFor) : [];
  const photosPending = photosFor ? (pendingByRoom[photosFor] ?? []) : [];
  const photosFree = ROOM_PHOTO_LIMIT - photosRoomPhotos.length - photosPending.length;

  return (
    <div className="mx-auto max-w-[1448px] space-y-5">
      <PageHeader
        action={
          <Button
            className="bg-brand-teal text-white hover:bg-brand-teal/90"
            disabled={addableRoomTypes.length === 0}
            onClick={() => setAdding(true)}
            title={addableRoomTypes.length === 0 ? "Every room type is already on your list." : undefined}
            type="button"
          >
            <Plus className="size-4" />
            Add room type
          </Button>
        }
        description="Room types, their beds, and what is free right now."
        icon={BedDouble}
        title="Rooms & Beds"
      />
      <Message value={message} />

      {configurations.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <MetricCard icon={DoorOpen} label="Rooms" value={totals.rooms} />
          <MetricCard icon={BedDouble} label="Beds" note={`${fullShare}% taken`} value={totals.beds} />
          <MetricCard icon={Sparkles} label="Beds free" value={totals.vacant} />
        </div>
      ) : null}

      {configurations.length === 0 ? (
        <Panel>
          <EmptyState label="No room types yet. Add your first one from the header." />
        </Panel>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {configurations.map((config) => {
            const totalBeds = config.rooms * config.bedsPerRoom;
            const roomPhotos = photosOfKind(photos, "ROOM", config.roomType);
            const pending = pendingByRoom[config.roomType] ?? [];
            // What the public page falls back to while this room type has no
            // photos of its own.
            const cover = roomPhotos[0]?.url ?? resolveHostelPhotoUrls(photos, "ROOM", config.roomType)[0];
            const standIn = roomPhotos.length === 0;
            const state =
              config.vacantBeds === 0 ? "Full" : config.vacantBeds === totalBeds ? "Empty" : `${config.vacantBeds} free`;

            return (
              <article
                className="group overflow-hidden rounded-2xl border border-border/70 bg-card transition duration-200 hover:-translate-y-0.5 hover:shadow-md"
                key={config.roomType}
              >
                <button
                  aria-label={`${config.roomType} photos`}
                  className="relative block aspect-[16/9] w-full overflow-hidden bg-muted"
                  onClick={() => setPhotosFor(config.roomType)}
                  type="button"
                >
                  {cover ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      alt=""
                      className={cn(
                        "size-full object-cover transition duration-500 group-hover:scale-[1.03]",
                        standIn && "opacity-60 grayscale",
                      )}
                      src={cover}
                    />
                  ) : (
                    <span className="flex size-full items-center justify-center text-muted-foreground">
                      <Glyph className="size-8" name="image-add" />
                    </span>
                  )}
                  {standIn ? (
                    <span className="absolute left-2.5 top-2.5 rounded-full bg-black/60 px-2.5 py-0.5 text-[11px] font-semibold text-white backdrop-blur">
                      Stand-in photo
                    </span>
                  ) : null}
                  <span className="absolute bottom-2.5 right-2.5 inline-flex items-center gap-1 rounded-full bg-black/60 px-2.5 py-0.5 text-[11px] font-semibold text-white backdrop-blur">
                    <Glyph className="size-3.5" name="images" />
                    {roomPhotos.length + pending.length}/{ROOM_PHOTO_LIMIT}
                  </span>
                </button>

                <div className="space-y-3.5 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="font-heading text-[16px] font-bold tracking-tight text-foreground">
                      {config.roomType}
                    </h3>
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold",
                        config.vacantBeds === 0 ? "bg-foreground text-background" : "bg-role-team-soft text-role-team",
                      )}
                    >
                      {state}
                    </span>
                  </div>

                  <OccupancyBar occupied={totalBeds - config.vacantBeds} total={totalBeds} />

                  <div className="flex flex-wrap gap-1.5">
                    <Fact glyph="door">{`${config.rooms} rooms`}</Fact>
                    <Fact glyph="bed">{`${config.bedsPerRoom} per room`}</Fact>
                    {/* The rent is a fact, never a field: the rate card prices it. */}
                    <Fact glyph="cash" warn={!config.monthlyRent}>
                      {config.monthlyRent ? `${currency(config.monthlyRent)}/mo` : "Not priced"}
                    </Fact>
                  </div>

                  <div className="flex gap-2">
                    <Button onClick={() => setEditing(config.roomType)} size="sm" type="button" variant="outline">
                      <Pencil className="size-3.5" />
                      Edit
                    </Button>
                    <Button onClick={() => setPhotosFor(config.roomType)} size="sm" type="button" variant="ghost">
                      <ImagePlus className="size-3.5" />
                      Photos
                    </Button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <FloorsPanel />

      {/* Add a room type. */}
      <Dialog onOpenChange={setAdding} open={adding}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add a room type</DialogTitle>
            <DialogDescription>It starts with every bed free. Price it on the Fee Schedule.</DialogDescription>
          </DialogHeader>
          <BusyForm className="grid gap-3" onSubmit={addRoomType}>
            <Select label="Room type" name="roomType" required>
              <option value="">Select type</option>
              {addableRoomTypes.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </Select>
            <div className="grid grid-cols-2 gap-3">
              <Input label="Rooms" min="1" name="rooms" required type="number" />
              <Input label="Beds per room" min="1" name="bedsPerRoom" required type="number" />
            </div>
            <DialogFooter>
              <SubmitButton className="bg-brand-teal text-white hover:bg-brand-teal/90">Add room type</SubmitButton>
            </DialogFooter>
          </BusyForm>
        </DialogContent>
      </Dialog>

      {/* Edit counts. Keyed by type so the inputs reset to the row being edited. */}
      <Dialog onOpenChange={(open) => (open ? null : setEditing(null))} open={editingConfig !== null}>
        <DialogContent className="sm:max-w-md">
          {editingConfig ? (
            <>
              <DialogHeader>
                <DialogTitle>{editingConfig.roomType}</DialogTitle>
                <DialogDescription>Rooms, beds per room, and beds free right now.</DialogDescription>
              </DialogHeader>
              <BusyForm
                className="grid gap-3"
                key={editingConfig.roomType}
                onSubmit={(event) => updateRoomType(editingConfig.roomType, event)}
              >
                <div className="grid grid-cols-3 gap-3">
                  <Input defaultValue={editingConfig.rooms} label="Rooms" min="0" name="rooms" required type="number" />
                  <Input defaultValue={editingConfig.bedsPerRoom} label="Beds / room" min="1" name="bedsPerRoom" required type="number" />
                  <Input defaultValue={editingConfig.vacantBeds} label="Free beds" min="0" name="vacantBeds" required type="number" />
                </div>
                <DialogFooter className="sm:justify-between">
                  <Button
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => void removeRoomType(editingConfig.roomType)}
                    type="button"
                    variant="ghost"
                  >
                    <Trash2 className="size-4" />
                    Remove
                  </Button>
                  <SubmitButton className="bg-brand-teal text-white hover:bg-brand-teal/90">Save</SubmitButton>
                </DialogFooter>
              </BusyForm>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Photos for one room type. */}
      <Dialog onOpenChange={(open) => (open ? null : setPhotosFor(null))} open={photosFor !== null}>
        <DialogContent className="sm:max-w-2xl">
          {photosFor ? (
            <>
              <DialogHeader>
                <DialogTitle>{photosFor} photos</DialogTitle>
                <DialogDescription>
                  {photosRoomPhotos.length + photosPending.length} of {ROOM_PHOTO_LIMIT}. Visitors see these when they open this room type.
                </DialogDescription>
              </DialogHeader>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {photosRoomPhotos.map((photo, photoIndex) => {
                  const deleting = photo.id != null && deletingIds.includes(photo.id);

                  return (
                    <div className="group/photo relative" key={photo.id ?? photo.url}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        alt={photo.alt || `${photosFor} photo`}
                        className={cn(
                          "aspect-[4/3] w-full rounded-xl object-cover transition",
                          deleting ? "blur-[2px] brightness-90" : "cursor-zoom-in",
                        )}
                        onClick={() =>
                          deleting
                            ? undefined
                            : openViewer(
                                photosRoomPhotos.map((item) => ({ src: item.url ?? "", title: photosFor })),
                                photoIndex,
                              )
                        }
                        src={photo.url}
                      />
                      {deleting ? (
                        <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/25">
                          <Loader2 className="size-5 animate-spin text-white" />
                        </div>
                      ) : (
                        <Button
                          aria-label="Remove photo"
                          className="absolute right-1.5 top-1.5 size-7 opacity-0 transition group-hover/photo:opacity-100"
                          onClick={() => void deleteRoomPhoto(photo.id)}
                          size="icon"
                          type="button"
                          variant="destructive"
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      )}
                    </div>
                  );
                })}
                {photosPending.map((item) => (
                  <div className="relative" key={item.id}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      alt=""
                      className={cn(
                        "aspect-[4/3] w-full rounded-xl object-cover transition",
                        !item.uploaded && "blur-[2px] brightness-90",
                      )}
                      src={item.previewUrl}
                    />
                    {item.uploaded ? null : (
                      <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/25">
                        <Loader2 className="size-5 animate-spin text-white" />
                      </div>
                    )}
                  </div>
                ))}
                {photosFree > 0 ? (
                  <label
                    className={cn(
                      "flex aspect-[4/3] w-full flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-border text-[12px] font-semibold text-muted-foreground transition",
                      uploadingFor === photosFor ? "opacity-60" : "cursor-pointer hover:border-brand-teal hover:text-brand-teal",
                    )}
                  >
                    <Glyph className="size-6" name="image-add" />
                    Add
                    <input
                      accept={acceptAttribute("image")}
                      className="hidden"
                      disabled={uploadingFor === photosFor}
                      multiple
                      onChange={(event) => void uploadRoomPhotos(event, photosFor, photosFree)}
                      type="file"
                    />
                  </label>
                ) : null}
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
});
