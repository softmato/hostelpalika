import { Types } from "mongoose";
import type { z } from "zod";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { paginationMeta, paginationRange } from "@/lib/pagination";
import { REALTIME_TOPIC } from "@/lib/realtime/channels";
import { publishResourceChange } from "@/lib/realtime/server";
import { claimRegistrationDocuments } from "@/lib/registration-documents";
import { escapeRegex } from "@/lib/validators";
import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { ServiceProviderApplicationModel } from "@hostel/db/models/ServiceProviderApplication";
import { ServiceProviderDocumentModel } from "@hostel/db/models/ServiceProviderDocument";
import { HostelModel } from "@hostel/db/models/Hostel";
import { MaintenanceHistoryModel } from "@hostel/db/models/MaintenanceHistory";
import { MaintenanceRequestModel } from "@hostel/db/models/MaintenanceRequest";
import { ServiceProviderModel } from "@hostel/db/models/ServiceProvider";
import { UserModel } from "@hostel/db/models/User";
import { appUrl, sendNotificationEmail } from "@/modules/residents/resident-notify";
import { serviceProviderApprovedEmail } from "@hostel/shared/email/templates/service-provider/provider-approved";
import { serviceProviderRegistrationReceivedEmail } from "@hostel/shared/email/templates/service-provider/registration-received";
import { serviceProviderRejectedEmail } from "@hostel/shared/email/templates/service-provider/provider-rejected";
import { loadSiteConfig } from "@/lib/site-config-server";
import { categoryForRole } from "@/lib/maintenance-role-suggest";
import { normalizeProviderCategories } from "@/modules/service-providers/service-provider.validation";
import { notifyStaffOfJobProgress } from "@/modules/maintenance/maintenance-notify";
import {
  notifyPlatformOfServiceProviderApplication,
  notifyServiceProviderDecision,
} from "@/modules/service-providers/service-provider-notify";
import type {
  hostelAdminServiceProviderListQuerySchema,
  platformServiceProviderListQuerySchema,
  publicServiceProviderListQuerySchema,
  serviceProviderRegisterSchema,
  serviceProviderRejectSchema,
} from "@/modules/service-providers/service-provider.validation";

type MaintenanceJobRecord = {
  _id: Types.ObjectId;
  category: string;
  completedAt?: Date;
  createdAt?: Date;
  description?: string;
  hostelId: Types.ObjectId;
  location?: string;
  minimumCharge?: number;
  priority: string;
  providerId?: Types.ObjectId;
  scheduledFor?: Date;
  status: string;
  title: string;
  voiceNoteAssetId?: Types.ObjectId;
};

type HostelContactRecord = {
  _id: Types.ObjectId;
  contact?: { phone?: string };
  location?: { area?: string; city?: string };
  name: string;
};

type ServiceProviderRegisterInput = z.infer<typeof serviceProviderRegisterSchema>;
type PlatformServiceProviderListQuery = z.infer<
  typeof platformServiceProviderListQuerySchema
>;
type HostelAdminServiceProviderListQuery = z.infer<
  typeof hostelAdminServiceProviderListQuerySchema
>;
type ServiceProviderRejectInput = z.infer<typeof serviceProviderRejectSchema>;
type PublicServiceProviderListQuery = z.infer<
  typeof publicServiceProviderListQuerySchema
>;

type ServiceProviderStatus =
  "PENDING_APPROVAL" | "APPROVED" | "REJECTED" | "HIDDEN" | "INACTIVE";

type ServiceProviderRecord = {
  _id: Types.ObjectId;
  approvedAt?: Date;
  approvedBy?: Types.ObjectId;
  area: string;
  availability?: string;
  categories?: string[];
  category: string;
  city?: string;
  createdAt?: Date;
  description?: string;
  email?: string;
  experience?: string;
  fullName: string;
  hiddenAt?: Date;
  hiddenBy?: Types.ObjectId;
  phone: string;
  photoAssetId?: Types.ObjectId;
  ratingSummary?: {
    averageRating?: number;
    totalReviews?: number;
  };
  rejectionReason?: string;
  status: ServiceProviderStatus;
  updatedAt?: Date;
  /** Account that submitted the public application — the upgrade target on approval. */
  userId?: Types.ObjectId;
};

type ServiceProviderApplicationRecord = {
  _id: Types.ObjectId;
  providerId: Types.ObjectId;
  rejectionReason?: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  submittedAt?: Date;
};

type ServiceProviderDocumentRecord = {
  _id: Types.ObjectId;
  createdAt?: Date;
  documentType: string;
  fileAssetId?: Types.ObjectId;
  fileUrl?: string;
  providerId: Types.ObjectId;
  status: "PENDING" | "APPROVED" | "REJECTED";
};

export class ServiceProviderServiceError extends Error {
  constructor(
    message: string,
    public errorCode = "SERVICE_PROVIDER_ERROR",
    public status = 400,
  ) {
    super(message);
  }
}

function normalizeObjectId(value: string, label = "id") {
  if (!Types.ObjectId.isValid(value)) {
    throw new ServiceProviderServiceError(`Invalid ${label}.`, "INVALID_OBJECT_ID", 422);
  }

  return new Types.ObjectId(value);
}

/**
 * Matches a provider on any trade they work in, not just their headline one.
 * `categories` holds the full list on multi-trade records; older records have
 * only the `category` scalar, so both are checked. Since `category` is always
 * `categories[0]`, this never double-counts.
 */
function categoryMatchFilter(category: string) {
  return { $or: [{ categories: category }, { category }] };
}

/** All trades a provider works in, tolerating pre-multi-trade records. */
function providerCategories(provider: ServiceProviderRecord) {
  return provider.categories?.length ? provider.categories : [provider.category];
}

/** `DOCTOR_CLINIC` → `Doctor clinic`, for email copy. */
function providerCategoryLabel(category: string) {
  const words = category.toLowerCase().split("_");

  return words
    .map((word, index) =>
      index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word,
    )
    .join(" ");
}

function serializeProvider(provider: ServiceProviderRecord) {
  return {
    approvedAt: provider.approvedAt?.toISOString(),
    approvedBy: provider.approvedBy?.toString(),
    area: provider.area,
    availability: provider.availability ?? "",
    categories: providerCategories(provider),
    category: provider.category,
    city: provider.city ?? "Kathmandu",
    createdAt: provider.createdAt?.toISOString(),
    description: provider.description ?? "",
    email: provider.email ?? "",
    experience: provider.experience ?? "",
    fullName: provider.fullName,
    hiddenAt: provider.hiddenAt?.toISOString(),
    hiddenBy: provider.hiddenBy?.toString(),
    id: provider._id.toString(),
    phone: provider.phone,
    photoAssetId: provider.photoAssetId?.toString(),
    ratingSummary: provider.ratingSummary ?? {
      averageRating: 0,
      totalReviews: 0,
    },
    rejectionReason: provider.rejectionReason ?? "",
    status: provider.status,
    updatedAt: provider.updatedAt?.toISOString(),
  };
}

function serializeApplication(application: ServiceProviderApplicationRecord | null) {
  if (!application) {
    return null;
  }

  return {
    id: application._id.toString(),
    providerId: application.providerId.toString(),
    rejectionReason: application.rejectionReason ?? "",
    status: application.status,
    submittedAt: application.submittedAt?.toISOString(),
  };
}

function serializeDocument(document: ServiceProviderDocumentRecord) {
  return {
    // The review table shows when each file arrived — a licence uploaded weeks
    // after the application is worth a second look.
    createdAt: document.createdAt?.toISOString() ?? null,
    documentType: document.documentType,
    fileAssetId: document.fileAssetId?.toString() ?? null,
    fileUrl: document.fileUrl ?? "",
    id: document._id.toString(),
    providerId: document.providerId.toString(),
    status: document.status,
  };
}

async function auditProviderAction(
  principal: ApiPrincipal,
  provider: ServiceProviderRecord,
  action: string,
  metadata: Record<string, unknown> = {},
) {
  await AuditLogModel.create({
    action,
    actorId: principal.userId,
    entityId: provider._id.toString(),
    entityType: "ServiceProvider",
    metadata,
  });
}

async function findProviderOrThrow(providerId: string) {
  const provider = await ServiceProviderModel.findOne({
    _id: normalizeObjectId(providerId, "service provider id"),
    isDeleted: false,
  }).lean<ServiceProviderRecord | null>();

  if (!provider) {
    throw new ServiceProviderServiceError(
      "Service provider was not found.",
      "SERVICE_PROVIDER_NOT_FOUND",
      404,
    );
  }

  return provider;
}

async function providerBundle(provider: ServiceProviderRecord) {
  const [application, documents] = await Promise.all([
    ServiceProviderApplicationModel.findOne({
      providerId: provider._id,
      isDeleted: false,
    })
      .sort({ createdAt: -1 })
      .lean<ServiceProviderApplicationRecord | null>(),
    ServiceProviderDocumentModel.find({
      providerId: provider._id,
      isDeleted: false,
    }).lean<ServiceProviderDocumentRecord[]>(),
  ]);

  return {
    application: serializeApplication(application),
    documents: documents.map(serializeDocument),
    provider: serializeProvider(provider),
  };
}

/**
 * Statuses that mean "this account already has an application in play". A
 * REJECTED provider may apply again; the others may not.
 */
const ACTIVE_APPLICATION_STATUSES = [
  "PENDING_APPROVAL",
  "APPROVED",
  "HIDDEN",
  "INACTIVE",
] as const;

/**
 * Finds an account's application by the `userId` link *or* by its verified email.
 *
 * The email fallback matters for records created before the `userId` link
 * existed: without it they would be invisible to the very person who applied —
 * they would see "become a service provider" while the platform portal showed
 * their application sitting in Pending. New applications always carry a
 * `userId`, since the register route requires a session.
 *
 * The email comes from the account record, not from anything the caller sent, so
 * this cannot be used to read someone else's application.
 */
async function findOwnProvider(userId: string, filter: Record<string, unknown> = {}) {
  const objectId = normalizeObjectId(userId, "user id");
  const account = await UserModel.findById(objectId).select("email").lean<{
    email?: string;
  } | null>();
  const email = account?.email?.trim().toLowerCase();

  return ServiceProviderModel.findOne({
    ...filter,
    isDeleted: false,
    $or: [{ userId: objectId }, ...(email ? [{ email }] : [])],
  })
    .sort({ createdAt: -1 })
    .lean<ServiceProviderRecord | null>();
}

/**
 * The signed-in account's own application, or `null` if it has never applied.
 * Drives the status panel on the public registration landing page, so a returning
 * applicant sees "under review" instead of a form they would only duplicate.
 */
export async function getOwnServiceProviderApplication(userId: string) {
  await connectToDatabase();

  const provider = await findOwnProvider(userId);

  if (!provider) {
    return { provider: null };
  }

  // Matched by email on a record that predates the account link — adopt it now,
  // so approval has a concrete account to upgrade instead of just an address.
  if (!provider.userId) {
    await ServiceProviderModel.updateOne(
      { _id: provider._id, userId: { $exists: false } },
      { $set: { userId: normalizeObjectId(userId, "user id") } },
    );
  }

  const documentCount = await ServiceProviderDocumentModel.countDocuments({
    isDeleted: false,
    providerId: provider._id,
  });

  // Everything here is what this account itself submitted, so it is safe to hand
  // back — it is what the "view submitted details" panel shows. Nothing derived
  // from moderation beyond the status and the rejection reason is included.
  return {
    provider: {
      area: provider.area,
      availability: provider.availability ?? "",
      categories: providerCategories(provider),
      category: provider.category,
      city: provider.city ?? "Kathmandu",
      description: provider.description ?? "",
      documentCount,
      email: provider.email ?? "",
      experience: provider.experience ?? "",
      fullName: provider.fullName,
      id: provider._id.toString(),
      phone: provider.phone,
      rejectionReason: provider.rejectionReason ?? "",
      status: provider.status,
      submittedAt: provider.createdAt?.toISOString(),
    },
  };
}

export async function registerPublicServiceProvider(
  input: ServiceProviderRegisterInput,
  options: { userId: string },
) {
  await connectToDatabase();

  // The Google gate means a repeat submission is nearly always a double-click or
  // a re-opened tab, not a second business — one account, one live application.
  // Matches on the email too, for the same reason the status lookup does —
  // otherwise someone whose earlier application predates the `userId` link
  // could file a second one against the same address.
  const existing = await findOwnProvider(options.userId, {
    status: { $in: ACTIVE_APPLICATION_STATUSES },
  });

  if (existing) {
    throw new ServiceProviderServiceError(
      existing.status === "PENDING_APPROVAL"
        ? "You already have an application under review."
        : "This account is already registered as a service provider.",
      "SERVICE_PROVIDER_ALREADY_REGISTERED",
      409,
    );
  }

  // Before the provider row exists, so a document that fails its claim leaves
  // nothing half-filed.
  const claimedDocuments = await claimRegistrationDocuments(
    input.documents,
    options.userId,
  );
  const { categories, category } = normalizeProviderCategories(input);
  const provider = (await ServiceProviderModel.create({
    area: input.area,
    availability: input.availability,
    categories,
    category,
    city: input.city,
    description: input.description,
    email: input.email,
    experience: input.experience,
    fullName: input.fullName,
    phone: input.phone,
    photoAssetId: input.photoAssetId,
    status: "PENDING_APPROVAL",
    userId: options.userId,
  })) as ServiceProviderRecord;
  const application = await ServiceProviderApplicationModel.create({
    providerId: provider._id,
    snapshot: {
      area: input.area,
      categories,
      category,
      city: input.city,
      fullName: input.fullName,
      phone: input.phone,
    },
    status: "PENDING",
  });

  if (claimedDocuments.length > 0) {
    await ServiceProviderDocumentModel.insertMany(
      claimedDocuments.map((document) => ({
        documentType: document.documentType,
        fileAssetId: document.fileAssetId,
        providerId: provider._id,
        status: "PENDING",
      })),
    );
  }

  const documents = await ServiceProviderDocumentModel.find({
    providerId: provider._id,
    isDeleted: false,
  }).lean<ServiceProviderDocumentRecord[]>();

  // EMAIL_SYSTEM.md §6.1. Optional address, wrapped send — the listing is
  // already persisted and must not fail on a mail problem.
  if (provider.email) {
    await sendNotificationEmail({
      action: "service_provider_registration_received",
      to: provider.email,
      ...serviceProviderRegistrationReceivedEmail({
        category: providerCategoryLabel(provider.category),
        fullName: provider.fullName,
      }),
    });
  }

  // The applicant has been acknowledged; now tell the people who review.
  await notifyPlatformOfServiceProviderApplication({
    _id: provider._id,
    category: provider.category,
    city: provider.city,
    fullName: provider.fullName,
  });

  return {
    application: serializeApplication(application),
    documents: documents.map(serializeDocument),
    provider: serializeProvider(provider),
  };
}

export async function listPlatformServiceProviders(
  query: PlatformServiceProviderListQuery,
) {
  await connectToDatabase();

  const filter: Record<string, unknown> = {
    isDeleted: false,
  };

  if (query.area) {
    filter.area = new RegExp(escapeRegex(query.area), "i");
  }

  if (query.category) {
    Object.assign(filter, categoryMatchFilter(query.category));
  }

  if (query.status) {
    filter.status = query.status;
  }

  const { limit, skip } = paginationRange(query);

  const [providers, total] = await Promise.all([
    ServiceProviderModel.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean<ServiceProviderRecord[]>(),
    ServiceProviderModel.countDocuments(filter),
  ]);

  return {
    pagination: paginationMeta(query, total),
    providers: providers.map(serializeProvider),
  };
}

async function updateProviderStatus(
  providerId: string,
  principal: ApiPrincipal,
  status: ServiceProviderStatus,
  action: string,
  input: ServiceProviderRejectInput | undefined = undefined,
) {
  await connectToDatabase();

  const existingProvider = await findProviderOrThrow(providerId);
  const set: Record<string, unknown> = {
    status,
    updatedBy: principal.userId,
  };
  const unset: Record<string, ""> = {};
  const now = new Date();

  if (status === "APPROVED") {
    set.approvedAt = now;
    set.approvedBy = principal.userId;
    unset.rejectionReason = "";
    unset.hiddenAt = "";
    unset.hiddenBy = "";
  } else if (status === "REJECTED") {
    set.rejectionReason = input?.reason ?? "Rejected by platform.";
    unset.approvedAt = "";
    unset.approvedBy = "";
  } else if (status === "HIDDEN") {
    set.hiddenAt = now;
    set.hiddenBy = principal.userId;
  }

  const update: Record<string, unknown> = { $set: set };

  if (Object.keys(unset).length > 0) {
    update.$unset = unset;
  }

  const provider = await ServiceProviderModel.findOneAndUpdate(
    { _id: existingProvider._id, isDeleted: false },
    update,
    { new: true },
  ).lean<ServiceProviderRecord | null>();

  if (!provider) {
    throw new ServiceProviderServiceError(
      "Service provider was not found.",
      "SERVICE_PROVIDER_NOT_FOUND",
      404,
    );
  }

  if (status === "APPROVED" || status === "REJECTED") {
    await ServiceProviderApplicationModel.updateMany(
      { providerId: existingProvider._id, status: "PENDING" },
      {
        $set: {
          rejectionReason: status === "REJECTED" ? input?.reason : undefined,
          reviewedAt: now,
          reviewedBy: principal.userId,
          status: status === "APPROVED" ? "APPROVED" : "REJECTED",
          updatedBy: principal.userId,
        },
      },
    );
  }

  await auditProviderAction(principal, provider, action, {
    previousStatus: existingProvider.status,
    status,
  });

  // EMAIL_SYSTEM.md §6.2 / §6.3. HIDDEN is deliberately silent — hiding is a
  // moderation action, not a decision the provider is owed an email about.
  if (provider.email && (status === "APPROVED" || status === "REJECTED")) {
    const { identity: siteIdentity } = await loadSiteConfig();
    const email =
      status === "APPROVED"
        ? serviceProviderApprovedEmail({
            category: providerCategoryLabel(provider.category),
            fullName: provider.fullName,
            jobsUrl: appUrl("/jobs"),
            siteName: siteIdentity.siteName,
          })
        : serviceProviderRejectedEmail({
            fullName: provider.fullName,
            reason: input?.reason,
          });

    await sendNotificationEmail({
      action: `service_provider_${status.toLowerCase()}`,
      html: email.html,
      subject: email.subject,
      to: provider.email,
    });
  }

  // Approval re-issues any ID card this account already holds as a provider
  // card — the conversion the registration form warned them about. Records that
  // predate the `userId` link have no account to re-issue against.
  if (status === "APPROVED" && provider.userId) {
    /*
     * Imported at the call site, not at module scope. `sendIdCardEmail` reaches
     * `platform-id-card.server` and through it `@napi-rs/canvas`, a ~26 MB
     * prebuilt binary that `serverExternalPackages` copies out of node_modules
     * into the bundle of every function that can reach it. A static import here
     * put that binary into 82 functions — every route that touches
     * `hostel.service` — for one call that issues a card. A dynamic import
     * keeps it in the handful that actually render one.
     */
    const { sendIdCardEmail } = await import(
      "@/modules/users/id-card-delivery.service"
    );

    await sendIdCardEmail(provider.userId.toString(), "SERVICE_PROVIDER");
  }

  /*
   * And tell the applicant *in the app*, which is where they are.
   *
   * The email above is the record; this is what actually converts the phone.
   * `notifyServiceProviderDecision` writes a notification the mobile app reads
   * as a role change, so an approved provider's shell becomes the provider
   * portal while they are holding it rather than on their next cold start. See
   * that function, and `adoptRoleChange` in the app.
   */
  if ((status === "APPROVED" || status === "REJECTED") && provider.userId) {
    await notifyServiceProviderDecision({
      approved: status === "APPROVED",
      fullName: provider.fullName,
      providerId: provider._id.toString(),
      reason: status === "REJECTED" ? input?.reason : undefined,
      userId: provider.userId.toString(),
    });
  }

  return providerBundle(provider);
}

/**
 * The signed-in provider's job board: `jobs` assigned to them, and `available`
 * — every unassigned PENDING request on the platform, any trade, theirs first.
 *
 * An unapproved or non-provider account gets two empty lists rather than an
 * error, because "no jobs" is exactly what they have.
 *
 * An available job carries no hostel phone and no voice note: those arrive once
 * the provider accepts it, so ten plumbers do not all ring the same hostel. The
 * voice note is also PRIVATE and `files/{id}/url` grants only the assigned
 * provider. Nothing about residents is included either way.
 */
export async function listOwnServiceProviderJobs(userId: string) {
  await connectToDatabase();

  const provider = await findOwnProvider(userId, { status: "APPROVED" });

  if (!provider) {
    return { available: [], jobs: [] };
  }

  const [requests, open] = await Promise.all([
    MaintenanceRequestModel.find({ isDeleted: false, providerId: provider._id })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean<MaintenanceJobRecord[]>(),
    MaintenanceRequestModel.find({
      isDeleted: false,
      providerId: { $exists: false },
      status: "PENDING",
    })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean<MaintenanceJobRecord[]>(),
  ]);

  const hostels = await HostelModel.find({
    _id: { $in: [...requests, ...open].map((request) => request.hostelId) },
  })
    .select("contact location name")
    .lean<HostelContactRecord[]>();

  const hostelById = new Map(hostels.map((hostel) => [hostel._id.toString(), hostel]));
  const myCategories = new Set<string>(providerCategories(provider).map(categoryForRole));

  const serialize = (request: MaintenanceJobRecord, accepted: boolean) => {
    const hostel = hostelById.get(request.hostelId.toString());

    return {
      category: request.category,
      createdAt: request.createdAt?.toISOString() ?? null,
      description: request.description ?? "",
      hostelArea: hostel?.location?.area ?? "",
      hostelCity: hostel?.location?.city ?? "",
      hostelName: hostel?.name ?? "A hostel",
      hostelPhone: accepted ? (hostel?.contact?.phone ?? "") : "",
      id: request._id.toString(),
      inMyTrade: myCategories.has(request.category),
      location: request.location ?? "",
      minimumCharge: request.minimumCharge ?? null,
      priority: request.priority,
      scheduledFor: request.scheduledFor?.toISOString() ?? null,
      status: request.status,
      title: request.title,
      // Read through `files/{assetId}/url`, which grants exactly the provider
      // this job is assigned to — the route is the authorization, not this list.
      voiceNoteAssetId: accepted ? (request.voiceNoteAssetId?.toString() ?? null) : null,
    };
  };

  return {
    // Stable sort: the provider's own trade first, newest first within each.
    available: open
      .map((request) => serialize(request, false))
      .sort((left, right) => Number(right.inMyTrade) - Number(left.inMyTrade)),
    jobs: requests.map((request) => serialize(request, true)),
  };
}

/**
 * A provider taking an open job off the board.
 *
 * Pinned to "still unassigned and PENDING", so two providers tapping at once
 * cannot both win — the loser gets a 409 that says somebody else has it. The
 * job moves straight to CONTACTED ("picked up" in the hostel's notification):
 * accepting is the provider saying they are on it.
 *
 * Any trade may be accepted — the board shows every job on purpose, and plenty
 * of local tradespeople do more than they registered for. The hostel sees who
 * took it and can cancel.
 */
export async function acceptServiceProviderJob(userId: string, jobId: string) {
  await connectToDatabase();

  const provider = await findOwnProvider(userId, { status: "APPROVED" });

  if (!provider) {
    throw new ServiceProviderServiceError(
      "Job was not found.",
      "MAINTENANCE_REQUEST_NOT_FOUND",
      404,
    );
  }

  const accepted = await MaintenanceRequestModel.findOneAndUpdate(
    {
      _id: normalizeObjectId(jobId, "job id"),
      isDeleted: false,
      providerId: { $exists: false },
      status: "PENDING",
    },
    { $set: { providerId: provider._id, status: "CONTACTED", updatedBy: userId } },
    { new: true },
  ).lean<MaintenanceJobRecord | null>();

  if (!accepted) {
    throw new ServiceProviderServiceError(
      "Another provider already took this job, or the hostel closed it.",
      "MAINTENANCE_JOB_TAKEN",
      409,
    );
  }

  await MaintenanceHistoryModel.create({
    action: "MAINTENANCE_PROVIDER_ACCEPTED",
    actorId: userId,
    hostelId: accepted.hostelId,
    nextStatus: "CONTACTED",
    note: `Accepted by ${provider.fullName}.`,
    previousStatus: "PENDING",
    requestId: accepted._id,
  });

  await AuditLogModel.create({
    action: "MAINTENANCE_PROVIDER_ACCEPTED",
    actorId: userId,
    entityId: accepted._id.toString(),
    entityType: "MaintenanceRequest",
    hostelId: accepted.hostelId,
    metadata: { providerId: provider._id.toString(), source: "SERVICE_PROVIDER" },
  });

  await publishResourceChange({
    hostelIds: [accepted.hostelId.toString()],
    topics: [REALTIME_TOPIC.MAINTENANCE],
  });

  await notifyStaffOfJobProgress({
    actorUserId: userId,
    previousStatus: "PENDING",
    providerName: provider.fullName,
    request: accepted,
  });

  return { job: { id: accepted._id.toString(), status: accepted.status } };
}

/**
 * The two status moves a provider can make on their own assigned job.
 *
 * Deliberately not the admin's five. `CANCELLED` is the hostel's decision, not
 * the contractor's; `SCHEDULED` carries a date the provider has no field to
 * set; and `PENDING` is a reversal that would let a provider quietly un-finish
 * work after being paid for it. What is left is the pair that only the person
 * holding the spanner knows: they have made contact, and they are done.
 */
export type ProviderJobStatus = "COMPLETED" | "CONTACTED";

/**
 * A provider marking their own job contacted or complete.
 *
 * Scoped through `findOwnProvider` and pinned to `providerId`, so the id in the
 * path is only ever resolved within the caller's own assignments — a job
 * belonging to another provider is reported as a plain miss rather than a 403
 * (RULES.md §3), which is also what an unapproved account gets.
 *
 * `CANCELLED` and `COMPLETED` are terminal: reopening a closed job is the
 * hostel's call, so a provider who taps twice gets a refusal rather than
 * silently rewriting the completion date.
 */
export async function updateOwnServiceProviderJobStatus(
  userId: string,
  jobId: string,
  input: { note?: string; status: ProviderJobStatus },
) {
  await connectToDatabase();

  const provider = await findOwnProvider(userId, { status: "APPROVED" });

  if (!provider) {
    throw new ServiceProviderServiceError(
      "Job was not found.",
      "MAINTENANCE_REQUEST_NOT_FOUND",
      404,
    );
  }

  const job = await MaintenanceRequestModel.findOne({
    _id: normalizeObjectId(jobId, "job id"),
    isDeleted: false,
    providerId: provider._id,
  }).lean<MaintenanceJobRecord | null>();

  if (!job) {
    throw new ServiceProviderServiceError(
      "Job was not found.",
      "MAINTENANCE_REQUEST_NOT_FOUND",
      404,
    );
  }

  if (job.status === "COMPLETED" || job.status === "CANCELLED") {
    throw new ServiceProviderServiceError(
      "This job is already closed. Ask the hostel to reopen it.",
      "MAINTENANCE_REQUEST_CLOSED",
      409,
    );
  }

  const set: Record<string, unknown> = { status: input.status, updatedBy: userId };

  if (input.status === "COMPLETED") {
    set.completedAt = new Date();
  }

  const updated = await MaintenanceRequestModel.findOneAndUpdate(
    // Pinned to the status we read, so two taps racing each other cannot both
    // win and write two completion dates.
    { _id: job._id, isDeleted: false, status: job.status },
    { $set: set },
    { new: true },
  ).lean<MaintenanceJobRecord | null>();

  if (!updated) {
    throw new ServiceProviderServiceError(
      "This job changed while you were working on it. Pull to refresh.",
      "MAINTENANCE_REQUEST_CONFLICT",
      409,
    );
  }

  await MaintenanceHistoryModel.create({
    action: "MAINTENANCE_STATUS_UPDATED",
    actorId: userId,
    hostelId: job.hostelId,
    nextStatus: updated.status,
    note: input.note,
    previousStatus: job.status,
    requestId: job._id,
  });

  await AuditLogModel.create({
    action: "MAINTENANCE_STATUS_UPDATED",
    actorId: userId,
    entityId: job._id.toString(),
    entityType: "MaintenanceRequest",
    hostelId: job.hostelId,
    metadata: {
      nextStatus: updated.status,
      previousStatus: job.status,
      providerId: provider._id.toString(),
      source: "SERVICE_PROVIDER",
    },
  });

  // The hostel's maintenance queue is watching this topic, so the admin sees
  // "completed" without refreshing. The provider is not on the hostel channel —
  // they are not a member of it — so their own list refreshes from the response.
  await publishResourceChange({
    hostelIds: [job.hostelId.toString()],
    topics: [REALTIME_TOPIC.MAINTENANCE],
  });

  /*
   * And the half the socket cannot do. `publishResourceChange` updates a
   * maintenance queue somebody already has open; a hostel whose desk is closed
   * for the evening learns that the plumber has been and gone whenever it next
   * opens that screen. This reaches them on their phone and in their browser.
   */
  await notifyStaffOfJobProgress({
    actorUserId: userId,
    previousStatus: job.status,
    providerName: provider.fullName ?? "The service provider",
    request: { ...job, status: updated.status },
  });

  return {
    job: {
      completedAt: updated.completedAt?.toISOString() ?? null,
      id: updated._id.toString(),
      status: updated.status,
    },
  };
}

export function approveServiceProvider(providerId: string, principal: ApiPrincipal) {
  return updateProviderStatus(
    providerId,
    principal,
    "APPROVED",
    "SERVICE_PROVIDER_APPROVED",
  );
}

export function rejectServiceProvider(
  providerId: string,
  input: ServiceProviderRejectInput,
  principal: ApiPrincipal,
) {
  return updateProviderStatus(
    providerId,
    principal,
    "REJECTED",
    "SERVICE_PROVIDER_REJECTED",
    input,
  );
}

export function hideServiceProvider(providerId: string, principal: ApiPrincipal) {
  return updateProviderStatus(providerId, principal, "HIDDEN", "SERVICE_PROVIDER_HIDDEN");
}

export async function listApprovedServiceProvidersForHostel(
  query: HostelAdminServiceProviderListQuery,
) {
  await connectToDatabase();

  const filter: Record<string, unknown> = {
    isDeleted: false,
    status: "APPROVED",
  };

  if (query.area) {
    filter.area = new RegExp(escapeRegex(query.area), "i");
  }

  // Both clauses below want `$or`, so they are combined under `$and` rather than
  // assigned to `filter.$or` in turn — the second would silently drop the first.
  const conditions: Record<string, unknown>[] = [];

  if (query.category) {
    conditions.push(categoryMatchFilter(query.category));
  }

  if (query.q) {
    const pattern = new RegExp(escapeRegex(query.q), "i");
    conditions.push({
      $or: [
        { fullName: pattern },
        { phone: pattern },
        { area: pattern },
        { description: pattern },
      ],
    });
  }

  if (conditions.length > 0) {
    filter.$and = conditions;
  }

  const { limit, skip } = paginationRange(query);

  const [providers, total] = await Promise.all([
    ServiceProviderModel.find(filter)
      .sort({ category: 1, area: 1, fullName: 1 })
      .skip(skip)
      .limit(limit)
      .lean<ServiceProviderRecord[]>(),
    ServiceProviderModel.countDocuments(filter),
  ]);

  return {
    pagination: paginationMeta(query, total),
    providers: providers.map(serializeProvider),
  };
}

/**
 * Public directory listing. Deliberately **not** {@link serializeProvider}: the
 * phone number is the provider's private contact detail and stays behind the
 * hostel-admin endpoint (PHASES.md §5.1 — "Contact info visible only to hostel
 * admins"). The public sees a verified profile and nothing to cold-call.
 */
function serializePublicProvider(provider: ServiceProviderRecord) {
  return {
    area: provider.area,
    availability: provider.availability ?? "",
    categories: providerCategories(provider),
    category: provider.category,
    city: provider.city ?? "Kathmandu",
    description: provider.description ?? "",
    experience: provider.experience ?? "",
    fullName: provider.fullName,
    id: provider._id.toString(),
    photoAssetId: provider.photoAssetId?.toString(),
    ratingSummary: provider.ratingSummary ?? { averageRating: 0, totalReviews: 0 },
    verified: true,
  };
}

export async function listPublicServiceProviders(query: PublicServiceProviderListQuery) {
  await connectToDatabase();

  // Location narrows what is *countable*; category only narrows what is listed.
  // Keeping them apart means the category chips still show how many providers
  // sit behind each one while a category is selected.
  const scopeFilter: Record<string, unknown> = {
    isDeleted: false,
    // HIDDEN and INACTIVE providers are approved but must not surface here.
    status: "APPROVED",
  };

  if (query.area) {
    scopeFilter.area = new RegExp(escapeRegex(query.area), "i");
  }

  if (query.city) {
    scopeFilter.city = new RegExp(escapeRegex(query.city), "i");
  }

  const [providers, counts, total] = await Promise.all([
    ServiceProviderModel.find({
      ...scopeFilter,
      ...(query.category ? categoryMatchFilter(query.category) : {}),
    })
      .sort({ category: 1, area: 1, fullName: 1 })
      .limit(120)
      .lean<ServiceProviderRecord[]>(),
    // A multi-trade provider counts once under each trade they work in, so the
    // list is unwound before grouping. `$ifNull` covers pre-multi-trade records,
    // which carry only the scalar.
    ServiceProviderModel.aggregate<{ _id: string; count: number }>([
      { $match: scopeFilter },
      {
        $project: {
          category: {
            $cond: [
              { $gt: [{ $size: { $ifNull: ["$categories", []] } }, 0] },
              "$categories",
              ["$category"],
            ],
          },
        },
      },
      { $unwind: "$category" },
      { $group: { _id: "$category", count: { $sum: 1 } } },
    ]),
    // Counted separately: summing the per-category counts would count a
    // two-trade provider twice, and this drives the "registered providers" stat.
    ServiceProviderModel.countDocuments(scopeFilter),
  ]);

  const countsByCategory = counts.reduce<Record<string, number>>((totals, entry) => {
    totals[entry._id] = entry.count;
    return totals;
  }, {});

  return {
    countsByCategory,
    providers: providers.map(serializePublicProvider),
    total,
  };
}

/**
 * The three numbers the public registration hero leads with.
 *
 * Separate from {@link listPublicServiceProviders} because that one exists to
 * return *providers* and this one never wants the documents: the landing page
 * is server-rendered on every visit and pulling 120 records to show three
 * integers is the kind of thing that only looks free until the directory grows.
 *
 * **`medianApprovalDays` is measured, not asserted.** The page used to print a
 * flat "2 days" review time that nobody had ever checked against the queue; a
 * promise about our own turnaround is exactly the claim an applicant will hold
 * us to, so it is now the median of what we have actually done. `null` when no
 * provider has been approved yet, and the hero drops the stat rather than
 * inventing a number for an empty table.
 */
export async function getPublicServiceProviderStats() {
  await connectToDatabase();

  const scopeFilter = { isDeleted: false, status: "APPROVED" };

  const [totalProviders, areaRows, approvalRows] = await Promise.all([
    ServiceProviderModel.countDocuments(scopeFilter),
    // Areas are free text an applicant typed, so "Baneshwor" and "baneshwor "
    // are one place. Trimmed and lowercased before grouping, or the count
    // inflates every time somebody capitalises differently.
    ServiceProviderModel.aggregate<{ count: number }>([
      { $match: scopeFilter },
      { $group: { _id: { $toLower: { $trim: { input: "$area" } } } } },
      { $count: "count" },
    ]),
    // Median, not mean: one application that sat over a holiday would drag an
    // average past anything a new applicant will actually experience.
    ServiceProviderModel.aggregate<{ days: number[] }>([
      { $match: { ...scopeFilter, approvedAt: { $exists: true, $ne: null } } },
      {
        $project: {
          days: {
            $divide: [{ $subtract: ["$approvedAt", "$createdAt"] }, 1000 * 60 * 60 * 24],
          },
        },
      },
      { $sort: { days: 1 } },
      { $group: { _id: null, days: { $push: "$days" } } },
    ]),
  ]);

  const days = approvalRows[0]?.days ?? [];
  const middle = Math.floor(days.length / 2);

  return {
    areaCount: areaRows[0]?.count ?? 0,
    medianApprovalDays:
      days.length === 0
        ? null
        : days.length % 2 === 1
          ? days[middle]
          : (days[middle - 1] + days[middle]) / 2,
    totalProviders,
  };
}

/**
 * Full application for the platform review panel — every field the applicant
 * submitted plus their uploaded documents. Unlike the hostel-facing read this
 * one is status-agnostic: the whole point is reviewing a provider who is *not*
 * approved yet.
 */
export async function getPlatformServiceProvider(providerId: string) {
  await connectToDatabase();

  return providerBundle(await findProviderOrThrow(providerId));
}

export async function getApprovedServiceProviderForHostel(providerId: string) {
  await connectToDatabase();

  const provider = await ServiceProviderModel.findOne({
    _id: normalizeObjectId(providerId, "service provider id"),
    isDeleted: false,
    status: "APPROVED",
  }).lean<ServiceProviderRecord | null>();

  if (!provider) {
    throw new ServiceProviderServiceError(
      "Service provider was not found.",
      "SERVICE_PROVIDER_NOT_FOUND",
      404,
    );
  }

  return providerBundle(provider);
}
