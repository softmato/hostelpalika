import { connectToDatabase } from "@/lib/db";
import { buildAddressQuery } from "@/lib/maps/geocoding";
import { geocodeAndCacheHostel } from "@/modules/hostels/hostel-geo.service";
import { summarizeConfigurations } from "@/modules/hostels/hostel-capacity.service";
import { getOpenFeeSchedule } from "@/modules/finance/fee-schedule.service";
import { sendNotificationEmail } from "@/modules/residents/resident-notify";
import { HostelModel } from "@hostel/db/models/Hostel";
import { UserModel } from "@hostel/db/models/User";
import { hostelChangeRequestEmail } from "@hostel/shared/email/templates/platform/team-requests";
import type {
  hostelAdminProfileQuerySchema,
  hostelAdminProfileUpdateSchema,
  hostelChangeRequestSchema,
  hostelPhotoCreateSchema,
  hostelPhotoDeleteQuerySchema,
} from "@/modules/hostels/hostel.validation";
import {
  findScopedHostel,
  HostelServiceError,
  normalizeObjectId,
  serializeHostel,
  auditHostelAction,
  definedUpdate,
  type HostelRecord,
} from "@/modules/hostels/hostel.service";
import type { ApiPrincipal } from "@/lib/api-auth";
import type { z } from "zod";
import { hostelCode } from "@/lib/hostel-code";

type HostelAdminProfileQuery = z.infer<typeof hostelAdminProfileQuerySchema>;
type HostelAdminProfileUpdateInput = z.infer<typeof hostelAdminProfileUpdateSchema>;
type HostelPhotoCreateInput = z.infer<typeof hostelPhotoCreateSchema>;
type HostelPhotoDeleteQuery = z.infer<typeof hostelPhotoDeleteQuerySchema>;
type HostelChangeRequestInput = z.infer<typeof hostelChangeRequestSchema>;

/** Post-approval renames allowed before the superadmin flow takes over. */
const NAME_CHANGE_LIMIT = 2;
/** ROOM is per room type, the others are per hostel. */
const PHOTO_LIMITS = { EXTERIOR: 3, INTERIOR: 20, ROOM: 10 } as const;
const LOCKED_NAME_STATUSES = new Set(["APPROVED", "PUBLISHED"]);

export async function getHostelAdminProfile(
  query: HostelAdminProfileQuery,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const hostel = await findScopedHostel(principal, query.hostelId);

  return {
    // The Hostel ID the pricing page's "Get plan" checkout asks for. Only on the
    // hostel's own profile — `serializeHostel` also feeds public reads.
    hostel: { ...serializeHostel(hostel), hostelCode: hostelCode(String(hostel._id)) },
    /*
     * Whether the rents on this profile came from the rate card. The screen
     * renders them as facts with a link to the rate card when they did, and as
     * editable fields when the hostel has no card yet — which is every hostel on
     * its first day.
     */
    pricedByRateCard: Boolean(await getOpenFeeSchedule(hostel._id)),
  };
}

export async function updateHostelAdminProfile(
  input: HostelAdminProfileUpdateInput,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const hostel = await findScopedHostel(principal, input.hostelId);
  const profileUpdate = definedUpdate(input, ["hostelId"]);

  /*
   * The PAN/VAT number is written once. It is what a branch has to match, so
   * an owner who could change it could re-point their business at anybody's
   * branch; a correction goes through a superadmin.
   */
  if (profileUpdate.panNumber && hostel.panNumber) {
    delete profileUpdate.panNumber;
  }

  /*
   * Prices are not editable here once a rate card exists.
   *
   * They used to be, and that was the second half of the platform's worst
   * pricing bug: `roomConfigurations[].monthlyRent` and `pricing` were typed on
   * this form while `FeeSchedule` was typed on the rate-card screen, both were
   * read as "the rent" by different pages, and nothing compared them. A hostel
   * ended up advertising 18,000 and invoicing 174,000.
   *
   * The rate card is the source now and this listing is written from it
   * (`projectScheduleOntoListing`), so accepting a rent here would let this form
   * silently overwrite the projection until the next rate change put it back —
   * a price that changes depending on which screen was saved last.
   *
   * Stripped rather than refused: an owner editing their photos and their
   * address should not be stopped because the form also carries a rent field
   * that is now read-only. `pricedByRateCard` on the profile response is how the
   * screen knows to render those fields as facts with a link to the rate card.
   */
  const openSchedule = await getOpenFeeSchedule(hostel._id);

  if (openSchedule) {
    delete profileUpdate.pricing;

    if (Array.isArray(profileUpdate.roomConfigurations)) {
      const rentByRoomType = new Map(
        (hostel.roomConfigurations ?? []).map((configuration) => [
          configuration.roomType,
          configuration.monthlyRent,
        ]),
      );

      profileUpdate.roomConfigurations = (
        profileUpdate.roomConfigurations as { monthlyRent?: number; roomType: string }[]
      ).map((configuration) => ({
        ...configuration,
        // A room type invented on this form has no rate yet; keeping the
        // submitted figure lets the owner list it before finance prices it,
        // and the next rate card overwrites it.
        monthlyRent:
          rentByRoomType.get(configuration.roomType) ?? configuration.monthlyRent,
      }));
    }
  }

  // roomConfigurations is the source of truth for occupancy, so any edit to it
  // has to bring the derived capacity totals along or the dashboard and the
  // public listing start disagreeing.
  if (input.roomConfigurations) {
    profileUpdate.capacitySummary = summarizeConfigurations(input.roomConfigurations);

    // Dropping a room type takes its photos with it — an orphaned ROOM photo
    // would otherwise keep standing in as fallback imagery for a room type
    // the hostel no longer offers.
    const keptTypes = new Set(input.roomConfigurations.map((config) => config.roomType));

    profileUpdate.photos = (hostel.photos ?? []).filter(
      (photo) => photo.kind !== "ROOM" || keptTypes.has(photo.roomType ?? ""),
    );
  }

  // After approval a hostel may rename itself only NAME_CHANGE_LIMIT times;
  // anything past that goes through the superadmin change-request flow.
  const isRename = input.name !== undefined && input.name !== hostel.name;
  const renameIsLocked = LOCKED_NAME_STATUSES.has(hostel.status);

  if (isRename && renameIsLocked) {
    if ((hostel.nameChangeCount ?? 0) >= NAME_CHANGE_LIMIT) {
      throw new HostelServiceError(
        "Hostel name change limit reached. Send a change request to the platform team instead.",
        "NAME_CHANGE_LIMIT_REACHED",
        403,
      );
    }
  }

  /*
   * `location` is merged field by field, never replaced. A `$set` of the whole
   * object dropped every field the form did not send: the stored MANUAL flag
   * (so KYC's map-pin step unticked and the re-geocode below could pull the
   * pin back to the area centroid), the `landmark` and the pasted `mapLink`.
   * A field left out keeps its value; an empty string clears it.
   */
  const locationSet: Record<string, unknown> = {};
  const locationUnset: Record<string, ""> = {};

  for (const [key, value] of Object.entries(input.location ?? {})) {
    if (value === "") {
      locationUnset[`location.${key}`] = "";
    } else if (value !== undefined) {
      locationSet[`location.${key}`] = value;
    }
  }

  delete profileUpdate.location;

  const updatedHostel = await HostelModel.findOneAndUpdate(
    { _id: hostel._id, isDeleted: false },
    {
      $set: {
        ...profileUpdate,
        ...locationSet,
        updatedBy: principal.userId,
      },
      ...(Object.keys(locationUnset).length > 0 ? { $unset: locationUnset } : {}),
      ...(isRename && renameIsLocked ? { $inc: { nameChangeCount: 1 } } : {}),
    },
    { new: true },
  ).lean<HostelRecord | null>();

  if (!updatedHostel) {
    throw new HostelServiceError("Hostel was not found.", "HOSTEL_NOT_FOUND", 404);
  }

  await auditHostelAction(principal, hostel._id, "HOSTEL_PROFILE_UPDATED");

  // Refresh coordinates + nearby places when the address changed, the pin
  // moved, or coordinates are missing. Best-effort — never fail the save on a
  // map-provider hiccup (ARCHITECTURE.md §4.3). geocodeAndCacheHostel keeps a
  // MANUAL pin as-is and only rebuilds the nearby cache around it.
  const beforeAddress = buildAddressQuery(hostel.location ?? {});
  const afterAddress = buildAddressQuery(updatedHostel.location ?? {});
  const missingCoords =
    updatedHostel.location?.lat == null || updatedHostel.location?.lng == null;
  const pinMoved =
    hostel.location?.lat !== updatedHostel.location?.lat ||
    hostel.location?.lng !== updatedHostel.location?.lng;

  if (afterAddress && (missingCoords || pinMoved || beforeAddress !== afterAddress)) {
    const geo = await geocodeAndCacheHostel(String(updatedHostel._id)).catch(() => null);
    if (geo) {
      updatedHostel.location = {
        ...updatedHostel.location,
        lat: geo.coordinates.lat,
        lng: geo.coordinates.lng,
        locationSource: geo.source,
      };
    }
  }

  return {
    hostel: serializeHostel(updatedHostel),
    pricedByRateCard: Boolean(openSchedule),
  };
}

export async function addHostelAdminProfilePhoto(
  input: HostelPhotoCreateInput,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const hostel = await findScopedHostel(principal, input.hostelId);

  // ROOM photos are capped per room type, not across the whole hostel, so ten
  // shots of "Four Sharing" never eat into what "Single Room" can hold.
  if (input.kind === "ROOM") {
    const known = (hostel.roomConfigurations ?? []).some(
      (config) => config.roomType === input.roomType,
    );

    if (!known) {
      throw new HostelServiceError(
        `"${input.roomType}" is not one of your room types.`,
        "ROOM_TYPE_NOT_FOUND",
        404,
      );
    }
  }

  const kindCount = (hostel.photos ?? []).filter(
    (photo) =>
      (photo.kind ?? "INTERIOR") === input.kind &&
      (input.kind !== "ROOM" || photo.roomType === input.roomType),
  ).length;

  if (kindCount >= PHOTO_LIMITS[input.kind]) {
    const scope =
      input.kind === "ROOM"
        ? `photo(s) for "${input.roomType}"`
        : `${input.kind.toLowerCase()} photo(s)`;

    throw new HostelServiceError(
      `You can upload at most ${PHOTO_LIMITS[input.kind]} ${scope}. Remove one first.`,
      "PHOTO_LIMIT_REACHED",
      422,
    );
  }

  const updatedHostel = await HostelModel.findOneAndUpdate(
    { _id: hostel._id, isDeleted: false },
    {
      $push: {
        photos: {
          alt: input.alt,
          fileAssetId: input.fileAssetId,
          kind: input.kind,
          roomType: input.kind === "ROOM" ? input.roomType : undefined,
          url: input.url,
        },
      },
      $set: {
        updatedBy: principal.userId,
      },
    },
    { new: true },
  ).lean<HostelRecord | null>();

  if (!updatedHostel) {
    throw new HostelServiceError("Hostel was not found.", "HOSTEL_NOT_FOUND", 404);
  }

  await auditHostelAction(principal, hostel._id, "HOSTEL_PROFILE_PHOTO_ADDED");

  return {
    hostel: serializeHostel(updatedHostel),
  };
}

/**
 * Emails every superadmin a locked-field change request (extra hostel renames,
 * owner name, or account email). The superadmin verifies, applies the change in
 * the platform portal, and the resulting notification email closes the loop.
 */
export async function requestHostelProfileChange(
  input: HostelChangeRequestInput,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const hostel = await findScopedHostel(principal, input.hostelId);
  const superadmins = await UserModel.find({
    isDeleted: { $ne: true },
    role: "SUPERADMIN",
    status: "ACTIVE",
  }).lean<Array<{ email: string }>>();

  const changeLabel = {
    HOSTEL_NAME: "Hostel name",
    OWNER_EMAIL: "Owner account email",
    OWNER_NAME: "Owner name",
  }[input.changeType];

  await auditHostelAction(principal, hostel._id, "HOSTEL_CHANGE_REQUESTED", {
    changeType: input.changeType,
    reason: input.reason ?? "",
    requestedValue: input.requestedValue,
  });

  const changeEmail = hostelChangeRequestEmail({
    change: changeLabel,
    hostelName: hostel.name ?? "",
    hostelSlug: hostel.slug ?? "",
    newValue: input.requestedValue,
    reason: input.reason,
  });

  await Promise.all(
    superadmins.map((admin) =>
      sendNotificationEmail({
        action: "hostel_change_request",
        html: changeEmail.html,
        subject: changeEmail.subject,
        to: admin.email,
      }),
    ),
  );

  return {
    changeType: input.changeType,
    notifiedAdmins: superadmins.length,
    status: "SUBMITTED" as const,
  };
}

export async function deleteHostelAdminProfilePhoto(
  photoId: string,
  query: HostelPhotoDeleteQuery,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const hostel = await findScopedHostel(principal, query.hostelId);
  const updatedHostel = await HostelModel.findOneAndUpdate(
    { _id: hostel._id, isDeleted: false },
    {
      $pull: {
        photos: {
          _id: normalizeObjectId(photoId),
        },
      },
      $set: {
        updatedBy: principal.userId,
      },
    },
    { new: true },
  ).lean<HostelRecord | null>();

  if (!updatedHostel) {
    throw new HostelServiceError("Hostel was not found.", "HOSTEL_NOT_FOUND", 404);
  }

  await auditHostelAction(principal, hostel._id, "HOSTEL_PROFILE_PHOTO_DELETED", {
    photoId,
  });

  return {
    hostel: serializeHostel(updatedHostel),
  };
}
