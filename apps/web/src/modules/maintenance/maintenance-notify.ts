import type { Types } from "mongoose";

import { categoryForRole, PROVIDER_ROLES } from "@/lib/maintenance-role-suggest";
import { createInAppNotification } from "@/modules/notifications/notification.service";
import { getHostelName, resolveHostelStaffUserIds } from "@/modules/residents/resident-notify";
import { ServiceProviderModel } from "@hostel/db/models/ServiceProvider";

/**
 * Telling people about maintenance work.
 *
 * ## What was missing
 *
 * Maintenance was the one loop in the product where nobody was ever told
 * anything. A warden raised a request and the admin found out by opening the
 * queue; a job was assigned to a plumber and the plumber found out by opening
 * the app and looking; the plumber marked it done and the hostel found out the
 * same way. Every other module — complaints, payments, notices, food, SOS —
 * had a notifier; this one had an audit log and a socket topic, which tell a
 * screen that is already open and nobody who is not looking at it.
 *
 * The assignment case is the one that actually costs money. A job posted to a
 * contractor who is not looking at their phone is a job that waits until they
 * next open the app, and the leak the request is about carries on leaking.
 *
 * ## Everything here is best-effort
 *
 * The request row is committed before any of this runs. A failure to notify
 * must never turn a successfully-raised job into a failed one, so each function
 * swallows its own errors and the callers do not await a result they can act
 * on.
 */

type RequestLike = {
  _id: Types.ObjectId;
  category: string;
  hostelId: Types.ObjectId;
  location?: string;
  minimumCharge?: number;
  priority: string;
  status: string;
  title: string;
};

/** How a category reads in a sentence. `ROOM_REPAIR` is not a word. */
function readableCategory(category: string) {
  return category.toLowerCase().replace(/_/g, " ");
}

/** Urgency carried through to the push priority, not just to the copy. */
function priorityOf(request: RequestLike) {
  return request.priority === "URGENT"
    ? ("URGENT" as const)
    : request.priority === "HIGH"
      ? ("HIGH" as const)
      : ("NORMAL" as const);
}

function whereClause(request: RequestLike) {
  return request.location ? ` at ${request.location}` : "";
}

/**
 * The user account behind a provider record, when there is one.
 *
 * Only applications submitted through the public form carry a `userId` — a
 * provider entered by hand from the platform desk has none, and cannot be
 * notified at all. That is a data gap rather than an error, so it returns null
 * and the caller simply sends nothing.
 */
async function providerUserId(providerId: Types.ObjectId | string) {
  const provider = await ServiceProviderModel.findOne({ _id: providerId })
    .select({ fullName: 1, status: 1, userId: 1 })
    .lean<{ fullName?: string; status?: string; userId?: Types.ObjectId } | null>();

  if (!provider?.userId || provider.status !== "APPROVED") {
    return null;
  }

  return {
    name: provider.fullName ?? "Service provider",
    userId: provider.userId.toString(),
  };
}

/**
 * A job landing on a contractor's phone.
 *
 * `HIGH` at minimum regardless of the request's own priority: everything on
 * this channel is somebody being asked to travel somewhere and do work, and a
 * push that Doze defers by an hour is worth nothing to a trade that schedules
 * its day in the morning.
 */
export async function notifyProviderOfAssignment(
  request: RequestLike & { providerId?: Types.ObjectId },
) {
  try {
    if (!request.providerId) {
      return;
    }

    const provider = await providerUserId(request.providerId);

    if (!provider) {
      return;
    }

    const hostelName = await getHostelName(request.hostelId);

    await createInAppNotification({
      actionUrl: "/jobs",
      body: `${hostelName} has sent you a ${readableCategory(request.category)} job: ${request.title}${whereClause(request)}.`,
      category: "MAINTENANCE",
      data: {
        maintenanceRequestId: request._id.toString(),
        priority: request.priority,
      },
      hostelId: request.hostelId.toString(),
      priority: request.priority === "URGENT" ? "URGENT" : "HIGH",
      title: "New job for you",
      userId: provider.userId,
    });
  } catch {
    // The assignment is already saved; the provider still sees it in their list.
  }
}

/**
 * A new unassigned job, told to every approved provider in that trade.
 *
 * Every provider can see the job on their board; only the ones whose trade
 * matches get a push, so a painter is not woken for a leak.
 *
 * ponytail: one row per provider across the whole platform — add an area/city
 * filter here when providers outside the hostel's city start complaining.
 */
async function notifyProvidersOfOpenJob(request: RequestLike) {
  try {
    const roles = PROVIDER_ROLES.filter((role) => categoryForRole(role) === request.category);
    const providers = await ServiceProviderModel.find({
      $or: [{ categories: { $in: roles } }, { category: { $in: roles } }],
      isDeleted: false,
      status: "APPROVED",
      userId: { $exists: true },
    })
      .select({ userId: 1 })
      .lean<{ userId: Types.ObjectId }[]>();

    if (providers.length === 0) {
      return;
    }

    const hostelName = await getHostelName(request.hostelId);
    const fee =
      request.minimumCharge === undefined
        ? ""
        : ` Minimum fee Rs ${request.minimumCharge.toLocaleString("en-US")}.`;

    await Promise.all(
      [...new Set(providers.map((provider) => provider.userId.toString()))].map((userId) =>
        createInAppNotification({
          actionUrl: "/jobs",
          body: `${hostelName}: ${request.title}${whereClause(request)}.${fee} Open the app to accept it.`,
          category: "MAINTENANCE",
          data: {
            maintenanceRequestId: request._id.toString(),
            priority: request.priority,
          },
          hostelId: request.hostelId.toString(),
          priority: request.priority === "URGENT" ? "URGENT" : "HIGH",
          title: `New ${readableCategory(request.category)} job`,
          userId,
        }),
      ),
    );
  } catch {
    // Best effort; the job is on the board either way.
  }
}

/**
 * A request raised, told to the rest of the desk.
 *
 * The person who raised it is excluded — they are looking at the confirmation
 * — but everyone else running the hostel is not, and on a shared front desk the
 * other copies are the only way a job somebody else logged is ever seen.
 */
export async function notifyStaffOfNewMaintenanceRequest(
  request: RequestLike & { providerId?: Types.ObjectId },
  actorUserId: string,
) {
  try {
    const [staff, hostelName] = await Promise.all([
      resolveHostelStaffUserIds(request.hostelId),
      getHostelName(request.hostelId),
    ]);

    const audience = staff.filter((userId) => userId !== actorUserId);

    await Promise.all(
      audience.map((userId) =>
        createInAppNotification({
          actionUrl: "/hostel-admin/maintenance",
          body: `${request.title}${whereClause(request)} — ${readableCategory(request.category)}, ${request.priority.toLowerCase()} priority.`,
          category: "MAINTENANCE",
          data: { maintenanceRequestId: request._id.toString() },
          hostelId: request.hostelId.toString(),
          priority: priorityOf(request),
          title: `Maintenance raised at ${hostelName}`,
          userId,
        }),
      ),
    );

  } catch {
    // Best effort; the queue holds the row either way.
  }

  // A request raised with somebody already on it is an assignment too;
  // otherwise it goes on the open board and the matching trade is told.
  // Outside the try above: a failed staff fan-out must not stop the dispatch.
  if (request.providerId) {
    await notifyProviderOfAssignment(request);
  } else {
    await notifyProvidersOfOpenJob(request);
  }
}

const STATUS_WORDS: Record<string, string> = {
  CANCELLED: "cancelled",
  COMPLETED: "completed",
  CONTACTED: "picked up",
  PENDING: "reopened",
  SCHEDULED: "scheduled",
};

/**
 * The hostel hearing back from the contractor.
 *
 * The direction that had no channel at all: a provider marks a job contacted or
 * complete from their phone, the hostel's open queue updates over the socket,
 * and anyone not sitting in front of that screen learns about it whenever they
 * next look. This is the half that reaches them.
 */
export async function notifyStaffOfJobProgress(input: {
  actorUserId?: string;
  previousStatus: string;
  providerName?: string;
  request: RequestLike;
}) {
  try {
    const { previousStatus, request } = input;

    if (previousStatus === request.status) {
      return;
    }

    const staff = await resolveHostelStaffUserIds(request.hostelId);
    const audience = staff.filter((userId) => userId !== input.actorUserId);
    const who = input.providerName ?? "The service provider";
    const word = STATUS_WORDS[request.status] ?? request.status.toLowerCase();

    await Promise.all(
      audience.map((userId) =>
        createInAppNotification({
          actionUrl: "/hostel-admin/maintenance",
          body: `${who} ${word} "${request.title}"${whereClause(request)}.`,
          category: "MAINTENANCE",
          data: {
            maintenanceRequestId: request._id.toString(),
            status: request.status,
          },
          hostelId: request.hostelId.toString(),
          priority: request.status === "COMPLETED" ? "NORMAL" : priorityOf(request),
          title: `Maintenance ${word}`,
          userId,
        }),
      ),
    );
  } catch {
    // Best effort.
  }
}

/**
 * The contractor hearing back from the hostel.
 *
 * Only for a job that has somebody on it, and only when the hostel moved it —
 * a provider does not need a notification telling them what they themselves
 * just tapped. Cancellation is the case that matters most: it is the one status
 * change that means "do not travel", and it is worthless if it arrives after
 * they have.
 */
export async function notifyProviderOfStatusChange(input: {
  previousStatus: string;
  request: RequestLike & { providerId?: Types.ObjectId };
}) {
  try {
    const { previousStatus, request } = input;

    if (!request.providerId || previousStatus === request.status) {
      return;
    }

    const provider = await providerUserId(request.providerId);

    if (!provider) {
      return;
    }

    const hostelName = await getHostelName(request.hostelId);
    const word = STATUS_WORDS[request.status] ?? request.status.toLowerCase();

    await createInAppNotification({
      actionUrl: "/jobs",
      body: `${hostelName} ${word} "${request.title}"${whereClause(request)}.`,
      category: "MAINTENANCE",
      data: {
        maintenanceRequestId: request._id.toString(),
        status: request.status,
      },
      hostelId: request.hostelId.toString(),
      priority: request.status === "CANCELLED" ? "HIGH" : "NORMAL",
      title: request.status === "CANCELLED" ? "Job cancelled" : `Job ${word}`,
      userId: provider.userId,
    });
  } catch {
    // Best effort.
  }
}

/**
 * A note the hostel wrote *for the contractor*, delivered to the contractor.
 *
 * The whole point of a `PROVIDER_NOTE` is that the two parties are not in the
 * same building — "the pump only runs after 6pm", "gate code changed". Written
 * into a screen the provider is not looking at, it may as well not exist.
 *
 * Only this direction, because only this direction exists: comments are written
 * through `addMaintenanceComment`, which scopes the request to the caller's own
 * hostel, so the author is always staff. If providers ever get a reply endpoint
 * it needs its own call here, and the notifier is not the place to guess at it
 * first.
 */
export async function notifyProviderOfMaintenanceNote(input: {
  body: string;
  request: RequestLike & { providerId?: Types.ObjectId };
}) {
  try {
    const { request } = input;

    if (!request.providerId) {
      return;
    }

    const provider = await providerUserId(request.providerId);

    if (!provider) {
      return;
    }

    const hostelName = await getHostelName(request.hostelId);

    await createInAppNotification({
      actionUrl: "/jobs",
      body: input.body.length > 140 ? `${input.body.slice(0, 137)}…` : input.body,
      category: "MAINTENANCE",
      data: { maintenanceRequestId: request._id.toString() },
      hostelId: request.hostelId.toString(),
      title: `${hostelName} on "${request.title}"`,
      userId: provider.userId,
    });
  } catch {
    // Best effort.
  }
}
