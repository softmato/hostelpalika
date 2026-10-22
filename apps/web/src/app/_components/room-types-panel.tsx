"use client";

import { bedsForRoomType, ROOM_TYPE_OPTIONS } from "@hostel/shared/constants/room-types";
import { ImagePlus, Loader2, Pencil, Plus, Trash2 } from "@/components/icons";
import { useCallback, useState, type ChangeEvent } from "react";

import { useConfirm } from "@/app/_components/confirm-dialog";
import { currency } from "@/app/_components/shared-ui";
import { Glyph } from "@/components/glyph";
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
import { hostelAdminEndpoints } from "@/lib/hostel-admin-endpoints";
import { photosOfKind, resolveHostelPhotoUrls, type HostelPhoto } from "@/lib/hostel-photos";
import { usePortalResource } from "@/lib/portal-query";
import { acceptAttribute } from "@/lib/uploads/accepts";
import { uploadFiles } from "@/lib/uploads/uploader";
import { cn } from "@/lib/utils";
import { toast } from "@/stores/toast-store";

import type { RoomConfiguration } from "./core-portal-shared";

/** Mirrors PHOTO_LIMITS.ROOM in hostel-profile.service — counted per room type. */
const ROOM_PHOTO_LIMIT = 10;
const ROOMS_URL = "/api/v1/hostel-admin/rooms";
const INPUT = "h-10 w-full rounded-xl border border-border bg-background px-3 text-sm outline-none focus:border-brand-teal";
const LABEL = "grid gap-1 text-xs font-semibold text-muted-foreground";

/**
 * The hostel's room types — Single, Double sharing… — each with its beds per
 * room, its rent from the rate card and its photos. With floors on, a type's
 * room count comes from the rooms placed on the floors below; with floors off,
 * the counts are typed here.
 *
 * Removing a type asks for the PIN, is refused while anybody lives in one of
 * its beds, and takes its numbered rooms with it (`updateHostelAdminProfile`).
 */
export function RoomTypesPanel() {
  const profile = usePortalResource<{ hostel: { photos?: HostelPhoto[]; roomConfigurations: RoomConfiguration[] } }>(
    hostelAdminEndpoints.profile,
    { errorMessage: "Could not load room types." },
  );
  const layout = usePortalResource<{ tracking: boolean }>(ROOMS_URL);
  const tracking = layout.data?.tracking ?? true;
  const configurations = profile.data?.hostel.roomConfigurations ?? [];
  const photos = profile.data?.hostel.photos ?? [];
  const { confirm, confirmDialog } = useConfirm();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<RoomConfiguration | null>(null);
  const [photosFor, setPhotosFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** Writes the whole list; `true` when the server took it. */
  const save = useCallback(
    async (next: RoomConfiguration[], done: string) => {
      setBusy(true);

      try {
        await browserApi(hostelAdminEndpoints.profile, {
          body: JSON.stringify({
            roomConfigurations: next.map((config) => ({
              bedsPerRoom: config.bedsPerRoom,
              mealInclusion: config.mealInclusion ?? "Included",
              // Carried through, never typed here: the rate card prices a room type.
              monthlyRent: config.monthlyRent,
              rooms: config.rooms,
              roomType: config.roomType,
              vacantBeds: config.vacantBeds,
            })),
          }),
          method: "PATCH",
        });
        toast.success({ title: done });
        await Promise.all([profile.refreshAsync(), layout.refreshAsync()]);
        return true;
      } catch (error) {
        toast.error({ description: error instanceof Error ? error.message : undefined, title: "Not saved" });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [layout, profile],
  );

  async function remove(config: RoomConfiguration) {
    const ok = await confirm({
      actionLabel: "Remove",
      description: tracking
        ? "Its numbered rooms on every floor go with it. Refused while anybody lives in one of its beds."
        : "Refused while anybody lives in one of its beds.",
      pin: true,
      title: `Remove ${config.roomType}?`,
      tone: "destructive",
    });

    if (ok && (await save(configurations.filter((item) => item.roomType !== config.roomType), `${config.roomType} removed.`))) {
      setEditing(null);
    }
  }

  if (!profile.data) {
    return <div className="h-28 animate-pulse rounded-2xl bg-muted" />;
  }

  return (
    <section className="space-y-3">
      {confirmDialog}
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="font-heading text-[15px] font-semibold text-foreground">Room types</h2>
          <p className="text-[12.5px] text-muted-foreground">What a bed is — beds per room, rent and photos.</p>
        </div>
        <Button disabled={busy} onClick={() => setAdding(true)} size="sm" type="button" variant="outline">
          <Plus className="size-3.5" />
          Add room type
        </Button>
      </div>

      {configurations.length === 0 ? (
        <button
          className="flex w-full flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-border px-4 py-8 text-center transition hover:border-brand-teal"
          onClick={() => setAdding(true)}
          type="button"
        >
          <span className="flex size-11 items-center justify-center rounded-full bg-brand-teal/10 text-brand-teal">
            <Plus className="size-5" />
          </span>
          <span className="text-sm font-semibold text-foreground">Add your first room type</span>
          <span className="text-xs text-muted-foreground">Single, Double sharing, Triple… then place the rooms on floors.</span>
        </button>
      ) : (
        <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
          {configurations.map((config) => {
            const own = photosOfKind(photos, "ROOM", config.roomType);
            const cover = own[0]?.url ?? resolveHostelPhotoUrls(photos, "ROOM", config.roomType)[0];
            const beds = config.rooms * config.bedsPerRoom;

            return (
              <article className="flex items-center gap-3 rounded-2xl border border-border/70 bg-card p-2.5" key={config.roomType}>
                <button
                  aria-label={`${config.roomType} photos`}
                  className="relative size-16 shrink-0 overflow-hidden rounded-xl bg-muted"
                  onClick={() => setPhotosFor(config.roomType)}
                  type="button"
                >
                  {cover ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img alt="" className={cn("size-full object-cover", own.length === 0 && "opacity-50 grayscale")} src={cover} />
                  ) : (
                    <span className="flex size-full items-center justify-center text-muted-foreground">
                      <ImagePlus className="size-5" />
                    </span>
                  )}
                  <span className="absolute bottom-1 right-1 rounded-full bg-black/60 px-1.5 text-[10px] font-semibold text-white">
                    {own.length}
                  </span>
                </button>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-foreground">{config.roomType}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {config.bedsPerRoom} {config.bedsPerRoom === 1 ? "bed" : "beds"} a room · {config.rooms}{" "}
                    {config.rooms === 1 ? "room" : "rooms"} · {config.vacantBeds}/{beds} free
                  </p>
                  <p className={cn("text-xs font-semibold", config.monthlyRent ? "text-foreground" : "text-warning")}>
                    {config.monthlyRent ? `${currency(config.monthlyRent)}/mo` : "Rent not set"}
                  </p>
                </div>
                <Button aria-label={`Edit ${config.roomType}`} onClick={() => setEditing(config)} size="icon" type="button" variant="ghost">
                  <Pencil className="size-4" />
                </Button>
              </article>
            );
          })}
        </div>
      )}

      {adding ? (
        <AddRoomTypeDialog
          busy={busy}
          existing={configurations.map((config) => config.roomType)}
          onAdd={async (roomType, bedsPerRoom, rooms) => {
            const ok = await save(
              [
                ...configurations,
                // Unpriced until the rate card prices it — zero is "not priced".
                { bedsPerRoom, mealInclusion: "Included", monthlyRent: 0, rooms, roomType, vacantBeds: rooms * bedsPerRoom },
              ],
              `${roomType} added.`,
            );
            if (ok) setAdding(false);
          }}
          onClose={() => setAdding(false)}
          tracking={tracking}
        />
      ) : null}

      <Dialog onOpenChange={(open) => (open ? null : setEditing(null))} open={editing !== null}>
        <DialogContent className="sm:max-w-md">
          {editing ? (
            <form
              className="grid gap-4"
              key={editing.roomType}
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                // Beds follow from the type's name; owners are never asked.
                const bedsPerRoom = bedsForRoomType(editing.roomType);
                const rooms = tracking ? editing.rooms : Number(form.get("rooms")) || 0;
                const vacantBeds = tracking ? editing.vacantBeds : Math.min(Number(form.get("vacantBeds")) || 0, rooms * bedsPerRoom);

                void save(
                  configurations.map((config) =>
                    config.roomType === editing.roomType ? { ...config, bedsPerRoom, rooms, vacantBeds } : config,
                  ),
                  `${editing.roomType} saved.`,
                ).then((ok) => ok && setEditing(null));
              }}
            >
              <DialogHeader>
                <DialogTitle>{editing.roomType}</DialogTitle>
                <DialogDescription>
                  {tracking ? "Rooms of this type are placed on the floors below." : "How many rooms, and how many beds are free now."}
                </DialogDescription>
              </DialogHeader>
              <div className="grid grid-cols-2 gap-3">
                {tracking ? null : (
                  <>
                    <label className={LABEL}>
                      Rooms
                      <input className={INPUT} defaultValue={editing.rooms} min={0} name="rooms" required type="number" />
                    </label>
                    <label className={LABEL}>
                      Free beds
                      <input className={INPUT} defaultValue={editing.vacantBeds} min={0} name="vacantBeds" required type="number" />
                    </label>
                  </>
                )}
              </div>
              <DialogFooter className="sm:justify-between">
                <Button
                  className="text-muted-foreground hover:text-destructive"
                  disabled={busy}
                  onClick={() => void remove(editing)}
                  type="button"
                  variant="ghost"
                >
                  <Trash2 className="size-4" />
                  Remove
                </Button>
                <Button disabled={busy} type="submit">
                  {busy ? "Saving…" : "Save"}
                </Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>

      {photosFor ? (
        <RoomPhotosDialog
          onChanged={() => void profile.refreshAsync()}
          onClose={() => setPhotosFor(null)}
          photos={photosOfKind(photos, "ROOM", photosFor)}
          roomType={photosFor}
        />
      ) : null}
    </section>
  );
}

function AddRoomTypeDialog({
  busy,
  existing,
  onAdd,
  onClose,
  tracking,
}: {
  busy: boolean;
  existing: string[];
  onAdd: (roomType: string, bedsPerRoom: number, rooms: number) => Promise<void>;
  onClose: () => void;
  tracking: boolean;
}) {
  const choices = ROOM_TYPE_OPTIONS.filter((option) => !existing.includes(option));
  const [roomType, setRoomType] = useState(choices[0] ?? "");
  const [custom, setCustom] = useState("");
  const name = custom.trim() || roomType;
  const taken = existing.some((item) => item.toLowerCase() === name.toLowerCase());

  return (
    <Dialog onOpenChange={(open) => (open ? null : onClose())} open>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a room type</DialogTitle>
          <DialogDescription>
            {tracking ? "Then add its rooms on a floor." : "Then set how many rooms it has."} Beds come from the name.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (name && !taken) void onAdd(name, bedsForRoomType(name), 0);
          }}
        >
          <div className="flex flex-wrap gap-1.5">
            {choices.map((option) => (
              <button
                className={cn(
                  "rounded-full border px-3 py-1.5 text-xs font-semibold transition",
                  option === roomType && !custom.trim() ? "border-brand-teal bg-brand-teal text-white" : "border-border text-foreground hover:bg-muted",
                )}
                key={option}
                onClick={() => {
                  setRoomType(option);
                  setCustom("");
                }}
                type="button"
              >
                {option}
              </button>
            ))}
          </div>
          <label className={LABEL}>
            Other
            <input className={INPUT} onChange={(event) => setCustom(event.target.value)} placeholder="6 Sharing" value={custom} />
            {name ? <span className="font-normal">{bedsForRoomType(name)} {bedsForRoomType(name) === 1 ? "bed" : "beds"} a room</span> : null}
          </label>
          <DialogFooter>
            <Button disabled={busy || !name || taken} type="submit">
              {busy ? "Adding…" : `Add ${name}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Up to ten photos a visitor sees when they open this room type. */
function RoomPhotosDialog({
  onChanged,
  onClose,
  photos,
  roomType,
}: {
  onChanged: () => void;
  onClose: () => void;
  photos: HostelPhoto[];
  roomType: string;
}) {
  const { open: openViewer } = useMediaViewer();
  const [uploading, setUploading] = useState(0);
  const [deleting, setDeleting] = useState<string[]>([]);
  const free = ROOM_PHOTO_LIMIT - photos.length - uploading;

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []).slice(0, Math.max(free, 0));
    event.currentTarget.value = "";
    if (files.length === 0) return;

    setUploading(files.length);

    try {
      for (const file of files) {
        const [outcome] = await uploadFiles([file], {
          accessLevel: "PUBLIC",
          kind: "image",
          label: `${roomType} photo`,
          scope: `room-photos:${roomType}`,
          silent: true,
        });

        if (outcome?.ok && outcome.result.assetId) {
          await browserApi(`${hostelAdminEndpoints.profile}/photos`, {
            body: JSON.stringify({
              alt: roomType,
              fileAssetId: outcome.result.assetId,
              kind: "ROOM",
              roomType,
              url: `/api/v1/files/${outcome.result.assetId}/url`,
            }),
            method: "POST",
          });
        }

        setUploading((count) => count - 1);
        onChanged();
      }
    } catch (error) {
      toast.error({ description: error instanceof Error ? error.message : undefined, title: "Upload failed" });
    } finally {
      setUploading(0);
    }
  }

  async function remove(photoId?: string) {
    if (!photoId) return;
    setDeleting((current) => [...current, photoId]);

    try {
      await browserApi(`${hostelAdminEndpoints.profile}/photos/${photoId}`, { method: "DELETE" });
      onChanged();
    } catch (error) {
      toast.error({ description: error instanceof Error ? error.message : undefined, title: "Not removed" });
    } finally {
      setDeleting((current) => current.filter((id) => id !== photoId));
    }
  }

  return (
    <Dialog onOpenChange={(open) => (open ? null : onClose())} open>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{roomType} photos</DialogTitle>
          <DialogDescription>
            {photos.length} of {ROOM_PHOTO_LIMIT}. Visitors see these when they open this room type.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {photos.map((photo, index) => (
            <div className="group/photo relative" key={photo.id ?? photo.url}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                alt={photo.alt || `${roomType} photo`}
                className={cn("aspect-[4/3] w-full cursor-zoom-in rounded-xl object-cover", photo.id && deleting.includes(photo.id) && "blur-[2px]")}
                onClick={() => openViewer(photos.map((item) => ({ src: item.url ?? "", title: roomType })), index)}
                src={photo.url}
              />
              <Button
                aria-label="Remove photo"
                className="absolute right-1.5 top-1.5 size-7 opacity-0 transition group-hover/photo:opacity-100"
                onClick={() => void remove(photo.id)}
                size="icon"
                type="button"
                variant="destructive"
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
          {Array.from({ length: uploading }, (_, index) => (
            <div className="flex aspect-[4/3] items-center justify-center rounded-xl bg-muted" key={`up-${index}`}>
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ))}
          {free > 0 ? (
            <label className="flex aspect-[4/3] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-border text-xs font-semibold text-muted-foreground transition hover:border-brand-teal hover:text-brand-teal">
              <Glyph className="size-6" name="image-add" />
              Add
              <input accept={acceptAttribute("image")} className="hidden" multiple onChange={(event) => void upload(event)} type="file" />
            </label>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
