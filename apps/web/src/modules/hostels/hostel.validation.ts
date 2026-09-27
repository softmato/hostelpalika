import { z } from "zod";

import { paginationQuerySchema } from "@/lib/pagination";

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Invalid object id.");

/**
 * A document uploaded privately through `POST /public/files/upload`, named by
 * the id and claim token that upload answered with (`lib/registration-documents.ts`).
 * A URL is not accepted: a document reachable by URL is a public document.
 */
const registrationDocumentSchema = z.object({
  claimToken: z.string().trim().min(20).max(200),
  documentType: z.string().trim().min(2).max(120),
  fileAssetId: objectIdSchema,
});

const textArraySchema = z.array(z.string().trim().min(1).max(80)).max(40).default([]);

/**
 * Photo locations are stored, not just rendered, so a relative `/api/v1/files/...`
 * path is the correct value: an origin baked in here would follow the record
 * forever, and a photo uploaded from a dev machine would send every production
 * visitor to their own localhost. Absolute http(s) links stay valid for
 * anything hosted elsewhere.
 */
const photoUrlSchema = z
  .string()
  .trim()
  .max(500)
  .refine(
    (value) => value.startsWith("/") || /^https?:\/\//i.test(value),
    "Photo URL must start with / or http(s)://",
  );

const optionalTextArraySchema = z.array(z.string().trim().min(1).max(80)).max(40);

const optionalHostelScopeSchema = {
  hostelId: objectIdSchema.optional(),
};

export const hostelTypeSchema = z.enum(["BOYS", "GIRLS", "CO_LIVING"]);

const roomConfigurationSchema = z.object({
  bedsPerRoom: z.coerce.number().int().nonnegative(),
  mealInclusion: z.enum(["Included", "Not Included", "Optional"]),
  monthlyRent: z.coerce.number().nonnegative().optional(),
  rooms: z.coerce.number().int().nonnegative(),
  roomType: z.string().trim().min(1).max(80),
  vacantBeds: z.coerce.number().int().nonnegative().default(0),
});

const roomConfigurationsSchema = z.array(roomConfigurationSchema).max(30).default([]);

export const platformHostelCreateSchema = z.object({
  capacitySummary: z
    .object({
      totalBeds: z.coerce.number().int().nonnegative().optional(),
      totalRooms: z.coerce.number().int().nonnegative().optional(),
      vacantBeds: z.coerce.number().int().nonnegative().optional(),
    })
    .optional(),
  contact: z
    .object({
      email: z.string().trim().email().optional(),
      phone: z.string().trim().min(7).max(24).optional(),
    })
    .optional(),
  description: z.string().trim().max(2000).optional(),
  documents: z.array(registrationDocumentSchema).max(12).default([]),
  facilities: textArraySchema,
  food: z
    .object({
      hasNonVeg: z.boolean().default(true),
      hasVeg: z.boolean().default(true),
      mealsPerDay: z.coerce.number().int().nonnegative().max(6).optional(),
      notes: z.string().trim().max(500).optional(),
    })
    .optional(),
  hostelType: hostelTypeSchema.default("CO_LIVING"),
  location: z.object({
    address: z.string().trim().max(240).optional(),
    area: z.string().trim().min(2).max(120),
    city: z.string().trim().min(2).max(120).default("Kathmandu"),
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    /*
     * MANUAL when somebody placed the pin on the building — an agent standing
     * in the lobby, or an owner dragging the marker onto their own gate. The
     * geocoder refuses to move a MANUAL pin, so recording *how* the coordinates
     * arrived is what stops the next nearby-places sweep sliding a hand-placed
     * hostel back to the middle of its neighbourhood.
     */
    locationSource: z.enum(["MANUAL", "GEOCODED"]).optional(),
    province: z.string().trim().max(120).optional(),
  }),
  name: z.string().trim().min(2).max(160),
  notes: z.string().trim().max(1000).optional(),
  ownerId: objectIdSchema,
  /*
   * `kind` and `roomType` are declared here because the model has always stored
   * them and every reader — the listing cover, the gallery, the per-room strip —
   * routes on them (`lib/hostel-photos.ts`). Without them on the way in, a form
   * that uploaded a categorised photo had the category stripped by zod and every
   * shot landed as INTERIOR, which is the default `kindOf` falls back to.
   *
   * `roomType` is only meaningful on a ROOM photo; the registration schema
   * checks it names a room type that was actually submitted.
   *
   * The cap moved from 20 to 40 with the same change. Twenty was enough while a
   * hostel had one undifferentiated pile of photos; a full setup is three
   * exteriors, a handful of interiors and a few shots of each room type, which
   * passes twenty before it has covered five room types.
   */
  photos: z
    .array(
      z.object({
        alt: z.string().trim().max(120).optional(),
        fileAssetId: objectIdSchema.optional(),
        kind: z.enum(["EXTERIOR", "INTERIOR", "ROOM"]).default("INTERIOR"),
        roomType: z.string().trim().min(1).max(80).optional(),
        url: photoUrlSchema,
      }),
    )
    .max(40)
    .default([]),
  pricing: z
    .object({
      admissionFee: z.coerce.number().nonnegative().optional(),
      currency: z.string().trim().min(2).max(8).default("NPR"),
      monthlyRentMax: z.coerce.number().nonnegative().optional(),
      monthlyRentMin: z.coerce.number().nonnegative().optional(),
    })
    .optional(),
  roomConfigurations: roomConfigurationsSchema,
  roomTypes: textArraySchema,
  rules: textArraySchema,
  /** Descriptive only — rooms are a flat per-hostel list, not grouped by floor. */
  totalFloors: z.coerce.number().int().min(0).max(50).optional(),
});

export const publicHostelApplicationCreateSchema = platformHostelCreateSchema
  .omit({ ownerId: true })
  .extend({
    applicant: z.object({
      email: z.string().trim().email().optional(),
      name: z.string().trim().min(2).max(120),
      phone: z.string().trim().min(7).max(24),
    }),
    selectedPlan: z.string().trim().min(2).max(80),
  });

export const platformHostelListQuerySchema = z.object({
  ...paginationQuerySchema,
  /**
   * Archived hostels are a separate queue, never mixed into the live one — the
   * approval queue is a list of decisions to make, and a hostel that is gone
   * from the site is not one of them. `only` is how the Archived tab asks for
   * them; everything else on the platform gets the default.
   */
  archived: z.enum(["exclude", "only"]).default("exclude"),
  status: z
    .enum(["DRAFT", "PENDING_APPROVAL", "APPROVED", "PUBLISHED", "REJECTED", "SUSPENDED"])
    .optional(),
  verificationStatus: z
    .enum(["UNVERIFIED", "PENDING", "VERIFIED", "REJECTED"])
    .optional(),
});

/**
 * The listing beacon's body.
 *
 * Capped at the page size the listing endpoint itself returns, so a caller
 * cannot claim an appearance for every hostel on the platform in one request.
 * Unknown and duplicate ids are dropped by `recordListingAppearances` rather
 * than rejected here — a stale id in a client's list is not a bad request.
 */
export const publicListingImpressionSchema = z.object({
  hostelIds: z.array(z.string()).min(1).max(60),
});

export const hostelRejectSchema = z.object({
  reason: z.string().trim().min(3).max(1000),
});

// Unpublishing pulls a live listing out of public search, so the owner is owed
// an explanation — the reason is required and goes straight into their email.
export const hostelUnpublishSchema = z.object({
  reason: z.string().trim().min(3).max(1000),
});

// A suspension takes a fixed reason, not free text: the owner's email and every
// portal's suspended screen are written for it (`hostel-suspension.ts`).
export const hostelSuspendSchema = z.object({
  reason: z.enum(["PLAN_PAYMENT"]),
});

// Archiving takes a hostel off the site, out of its own portal, and starts a
// 60-day countdown to erasure. The reason is required for the same purpose the
// audit row exists: so whoever finds the archived hostel later knows why.
export const hostelArchiveSchema = z.object({
  reason: z.string().trim().min(3).max(1000),
});

export const hostelRequestDocumentsSchema = z.object({
  documents: z
    .array(
      z.object({
        documentType: z.string().trim().min(2).max(120),
        note: z.string().trim().max(400).optional(),
      }),
    )
    .min(1, "Request at least one document.")
    .max(12),
  note: z.string().trim().max(1000).optional(),
});

export const hostelResubmitDocumentsSchema = z.object({
  documents: z
    .array(registrationDocumentSchema)
    .min(1, "Upload at least one document.")
    .max(12),
});

export const publicHostelListQuerySchema = z.object({
  area: z.string().trim().min(1).max(120).optional(),
  /** Exact city, any case — what a /hostels/in/[city] page lists. */
  city: z.string().trim().min(1).max(120).optional(),
  facility: z.string().trim().min(1).max(500).optional(),
  food: z.enum(["veg", "non-veg"]).optional(),
  maxPrice: z.coerce.number().nonnegative().optional(),
  minPrice: z.coerce.number().nonnegative().optional(),
  q: z.string().trim().min(1).max(160).optional(),
  roomType: z.string().trim().min(1).max(80).optional(),
  type: hostelTypeSchema.optional(),
});

export const publicHostelCompareQuerySchema = z.object({
  ids: z
    .string()
    .trim()
    .min(1)
    .transform((value) =>
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    )
    .pipe(
      z
        .array(objectIdSchema)
        .min(2, "Select at least 2 hostels to compare.")
        .max(3, "Compare up to 3 hostels at a time."),
    ),
});

export const inquiryStatusSchema = z.enum([
  "NEW",
  "CONTACTED",
  "VISIT_SCHEDULED",
  "CONVERTED",
  "CLOSED",
]);

export const publicInquiryCreateSchema = z.object({
  budgetRange: z.string().trim().max(80).optional(),
  email: z.string().trim().email().optional(),
  gender: z.string().trim().max(40).optional(),
  message: z.string().trim().max(1200).optional(),
  name: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(7).max(24),
  preferredRoomType: z.string().trim().max(80).optional(),
  preferredVisitDate: z.coerce.date().optional(),
});

export const hostelAdminInquiryListQuerySchema = z.object({
  ...paginationQuerySchema,
  ...optionalHostelScopeSchema,
  status: inquiryStatusSchema.optional(),
});

export const hostelAdminInquiryStatusSchema = z.object({
  ...optionalHostelScopeSchema,
  status: inquiryStatusSchema,
});

export const inquiryNoteCreateSchema = z.object({
  ...optionalHostelScopeSchema,
  nextFollowUpAt: z.coerce.date().optional(),
  note: z.string().trim().min(2).max(1200),
});

export const hostelAdminProfileQuerySchema = z.object(optionalHostelScopeSchema);

/**
 * Both directions of the location picker's lookup: `q` searches for a place (or
 * carries a pasted map link), `lat`/`lng` asks what address a pin sits on.
 *
 * `q` is generous about length because a shared Google Maps URL — the fastest
 * way for an admin to hand us the exact building — routinely runs past 200
 * characters once it carries the place's data blob.
 */
export const hostelAdminGeocodeQuerySchema = z
  .object({
    lat: z.coerce.number().min(-90).max(90).optional(),
    limit: z.coerce.number().int().min(1).max(8).default(5),
    lng: z.coerce.number().min(-180).max(180).optional(),
    /** The hostel's saved locality, used to disambiguate a bare place name. */
    near: z.string().trim().max(200).optional(),
    q: z.string().trim().min(2).max(2000).optional(),
  })
  .refine((input) => Boolean(input.q) || (input.lat != null && input.lng != null), {
    message: "Provide a search query, or a lat/lng pair to look up.",
    path: ["q"],
  });

export const hostelAdminProfileUpdateSchema = z.object({
  ...optionalHostelScopeSchema,
  capacitySummary: z
    .object({
      totalBeds: z.coerce.number().int().nonnegative().optional(),
      totalRooms: z.coerce.number().int().nonnegative().optional(),
      vacantBeds: z.coerce.number().int().nonnegative().optional(),
    })
    .optional(),
  contact: z
    .object({
      email: z.string().trim().email().optional(),
      phone: z.string().trim().min(7).max(24).optional(),
    })
    .optional(),
  description: z.string().trim().max(2000).optional(),
  facilities: optionalTextArraySchema.optional(),
  food: z
    .object({
      hasNonVeg: z.boolean().optional(),
      hasVeg: z.boolean().optional(),
      mealsPerDay: z.coerce.number().int().nonnegative().max(6).optional(),
      notes: z.string().trim().max(500).optional(),
    })
    .optional(),
  hostelType: hostelTypeSchema.optional(),
  location: z
    .object({
      address: z.string().trim().max(240).optional(),
      area: z.string().trim().min(2).max(120).optional(),
      city: z.string().trim().min(2).max(120).optional(),
      lat: z.coerce.number().min(-90).max(90).optional(),
      lng: z.coerce.number().min(-180).max(180).optional(),
      locationSource: z.enum(["MANUAL", "GEOCODED"]).optional(),
      province: z.string().trim().max(120).optional(),
    })
    .optional(),
  name: z.string().trim().min(2).max(160).optional(),
  /** Set once, while the hostel has none — it ties branches to this business. */
  panNumber: z.string().trim().regex(/^\d{9}$/, "A PAN/VAT number is 9 digits.").optional(),
  pricing: z
    .object({
      admissionFee: z.coerce.number().nonnegative().optional(),
      currency: z.string().trim().min(2).max(8).optional(),
      monthlyRentMax: z.coerce.number().nonnegative().optional(),
      monthlyRentMin: z.coerce.number().nonnegative().optional(),
    })
    .optional(),
  roomConfigurations: z.array(roomConfigurationSchema).max(30).optional(),
  roomTypes: optionalTextArraySchema.optional(),
  rules: optionalTextArraySchema.optional(),
  /** Descriptive only — rooms are a flat per-hostel list, not grouped by floor. */
  totalFloors: z.coerce.number().int().min(0).max(50).optional(),
});

export const hostelPhotoCreateSchema = z
  .object({
    ...optionalHostelScopeSchema,
    alt: z.string().trim().max(120).optional(),
    fileAssetId: objectIdSchema.optional(),
    kind: z.enum(["EXTERIOR", "INTERIOR", "ROOM"]).default("INTERIOR"),
    /** Required for ROOM photos — which room type the shot belongs to. */
    roomType: z.string().trim().min(1).max(120).optional(),
    url: photoUrlSchema,
  })
  .refine((input) => input.kind !== "ROOM" || Boolean(input.roomType), {
    message: "A room photo must name the room type it belongs to.",
    path: ["roomType"],
  });

/**
 * Locked-field changes (extra renames, owner name, account email) are requested
 * from the superadmin instead of edited directly by the hostel admin.
 */
export const hostelChangeRequestSchema = z.object({
  ...optionalHostelScopeSchema,
  changeType: z.enum(["HOSTEL_NAME", "OWNER_NAME", "OWNER_EMAIL"]),
  reason: z.string().trim().max(600).optional(),
  requestedValue: z.string().trim().min(2).max(240),
});

export const hostelPhotoDeleteQuerySchema = z.object(optionalHostelScopeSchema);

export const hostelScopedListQuerySchema = z.object(optionalHostelScopeSchema);

export const roomCreateSchema = z.object({
  ...optionalHostelScopeSchema,
  /** Beds "1".."capacity" are created with the room unless disabled. */
  autoCreateBeds: z.coerce.boolean().default(true),
  capacity: z.coerce.number().int().min(1).max(40),
  facilities: textArraySchema,
  notes: z.string().trim().max(800).optional(),
  repairStatus: z.enum(["OK", "NEEDS_REPAIR", "UNDER_REPAIR"]).default("OK"),
  roomNumber: z.string().trim().min(1).max(40),
  roomType: z.string().trim().min(1).max(80),
  vacancyStatus: z.enum(["VACANT", "PARTIAL", "FULL"]).default("VACANT"),
});

export const roomUpdateSchema = z.object({
  ...optionalHostelScopeSchema,
  capacity: z.coerce.number().int().min(1).max(40).optional(),
  facilities: optionalTextArraySchema.optional(),
  notes: z.string().trim().max(800).optional(),
  repairStatus: z.enum(["OK", "NEEDS_REPAIR", "UNDER_REPAIR"]).optional(),
  roomNumber: z.string().trim().min(1).max(40).optional(),
  roomType: z.string().trim().min(1).max(80).optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  vacancyStatus: z.enum(["VACANT", "PARTIAL", "FULL"]).optional(),
});

export const bedCreateSchema = z.object({
  ...optionalHostelScopeSchema,
  assignedResidentId: objectIdSchema.optional(),
  bedNumber: z.string().trim().min(1).max(40),
  notes: z.string().trim().max(800).optional(),
  repairStatus: z.enum(["OK", "NEEDS_REPAIR", "UNDER_REPAIR"]).default("OK"),
  roomId: objectIdSchema,
  status: z
    .enum(["AVAILABLE", "OCCUPIED", "RESERVED", "MAINTENANCE"])
    .default("AVAILABLE"),
});

export const bedUpdateSchema = z.object({
  ...optionalHostelScopeSchema,
  assignedResidentId: objectIdSchema.nullish(),
  bedNumber: z.string().trim().min(1).max(40).optional(),
  notes: z.string().trim().max(800).optional(),
  repairStatus: z.enum(["OK", "NEEDS_REPAIR", "UNDER_REPAIR"]).optional(),
  roomId: objectIdSchema.optional(),
  status: z.enum(["AVAILABLE", "OCCUPIED", "RESERVED", "MAINTENANCE"]).optional(),
});
