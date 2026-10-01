import { randomBytes } from "node:crypto";

import { Types } from "mongoose";

import type { ApiPrincipal } from "@/lib/api-auth";
import { afterResponse } from "@/lib/after-response";
import { connectToDatabase } from "@/lib/db";
import { hostelPeriodOf } from "@/lib/hostel-day";
import { logger } from "@/lib/logger";
import { outboundUrl } from "@/lib/site";
import { createInAppNotification } from "@/modules/notifications/notification.service";
import {
  type BillPreview,
  checkExistingResidents,
  type ListRow,
  monthLabel,
  type RowField,
  sameRoomType,
} from "@/modules/residents/existing-residents-check";
import { rentStatusLabel } from "@/modules/residents/existing-residents-sheet-model";
import {
  addScannedExistingResident,
  contextFor,
  ExistingResidentsError,
  roomTypesFor,
} from "@/modules/residents/existing-residents.service";
import type { JoinRequestInput } from "@/modules/residents/existing-residents.validation";
import { findLiveResidency } from "@/modules/residents/live-residency";
import { resolveHostelStaffUserIds, sendNotificationEmail } from "@/modules/residents/resident-notify";
import { getResidentIdentity } from "@/modules/users/resident-identity.service";
import { HostelModel } from "@hostel/db/models/Hostel";
import { ResidentApplicationModel } from "@hostel/db/models/ResidentApplication";
import { ResidentJoinLinkModel } from "@hostel/db/models/ResidentJoinLink";
import { joinRequestReturnedEmail } from "@hostel/shared/email/templates/resident/join-request-returned";

/**
 * The join link (docs/EXISTING_RESIDENTS.md, "Join link").
 *
 * The spreadsheet and the scan desk both need a warden to type or scan every
 * person. This turns it round: the hostel shares one link, each resident opens
 * it with their ID card, picks their room and says what rent is paid, and the
 * warden only checks and presses Add. Add is the scan desk's own path
 * (`addScannedExistingResident`), so a request becomes exactly the resident the
 * desk would have made — same bills, same part payment, same account link.
 *
 * Name, phone and face are the ID card's and nothing else's: the warden is
 * checking a person against a card, not against what they typed.
 */

/** Requests allowed past the free beds, so a few mistakes never close the link. */
export const JOIN_LINK_SPARE = 6;

/** An Add that died with its function is retried after this. */
const ADD_LOCK_MS = 6 * 60 * 1000;

/** Added requests stay on the staff list this long, as the record of who came in. */
const ADDED_SHOWN_DAYS = 30;

type LinkDoc = {
  _id: Types.ObjectId;
  cap: number;
  enabled: boolean;
  hostelId: Types.ObjectId;
  token: string;
  used: number;
};

type RequestDoc = {
  _id: Types.ObjectId;
  cardId: string;
  decidedAt?: Date | null;
  depositPaid: number;
  email: string;
  fullName: string;
  hostelId: Types.ObjectId;
  joinedDate?: Date | null;
  note?: string;
  paidTill: string;
  partPaid: number;
  phone: string;
  rejectReason?: string;
  residentId?: Types.ObjectId | null;
  roomType: string;
  sends: number;
  sentAt: Date;
  status: "ADDED" | "PENDING" | "REJECTED";
  userId: Types.ObjectId;
};

export type JoinLinkView = {
  cap: number;
  enabled: boolean;
  qrDataUrl: string | null;
  url: string;
  used: number;
  /** Requests waiting for a staff answer. */
  waiting: number;
};

export type JoinRequestView = {
  bills: BillPreview | null;
  cardId: string;
  decidedAt: string | null;
  depositPaid: number;
  email: string;
  fullName: string;
  id: string;
  joinedDate: string | null;
  note: string;
  paidTill: string;
  partPaid: number;
  phone: string;
  /** What would stop Add right now, in the check's own words. */
  problems: string[];
  rejectReason: string;
  rent: number | null;
  rentLabel: string;
  residentId: string | null;
  roomType: string;
  sends: number;
  sentAt: string;
  status: RequestDoc["status"];
};

export type JoinPageView = {
  currentMonth: { label: string; period: string };
  hostel: { city: string; name: string };
  /** OPEN takes new requests; FULL and OFF only let an existing one be fixed. */
  link: "FULL" | "OFF" | "OPEN";
  /** Their own request here, when they are signed in and have one. */
  request: JoinRequestView | null;
  roomTypes: { monthlyRent: number | null; roomType: string }[];
  token: string;
  /** Null when signed out. */
  viewer: {
    /** READY can send; the rest say what to do first. */
    card: "NONE" | "PRIVATE" | "READY";
    cardId: string | null;
    email: string;
    fullName: string;
    hasPhoto: boolean;
    /** Where they live already, when that stops them sending. */
    livesAt: { hostelName: string; sameHostel: boolean } | null;
    phone: string;
    photoUpdatedAt: string | null;
  } | null;
};

function joinError(message: string, errorCode: string, status = 422, details?: unknown) {
  return new ExistingResidentsError(message, errorCode, status, details);
}

export function joinUrl(token: string) {
  return `${outboundUrl()}/join/${token}`;
}

function newToken() {
  // 12 url-safe characters: short enough to read out, far too many to guess.
  return randomBytes(9).toString("base64url");
}

async function renderQr(text: string) {
  try {
    const { toDataURL } = await import("qrcode");

    return await toDataURL(text, { errorCorrectionLevel: "M", margin: 1, width: 480 });
  } catch {
    return null;
  }
}

function linkState(link: LinkDoc): JoinPageView["link"] {
  if (!link.enabled) return "OFF";

  return link.used >= link.cap ? "FULL" : "OPEN";
}

async function ensureLink(hostelId: Types.ObjectId, principal: ApiPrincipal): Promise<LinkDoc> {
  const existing = await ResidentJoinLinkModel.findOne({ hostelId }).lean<LinkDoc | null>();

  if (existing) return existing;

  const hostel = await HostelModel.findById(hostelId)
    .select("roomConfigurations")
    .lean<{ roomConfigurations?: { vacantBeds?: number }[] } | null>();
  const freeBeds = (hostel?.roomConfigurations ?? []).reduce(
    (sum, config) => sum + (config.vacantBeds ?? 0),
    0,
  );

  try {
    return (
      await ResidentJoinLinkModel.create({
        cap: Math.max(freeBeds, 1) + JOIN_LINK_SPARE,
        createdBy: principal.userId,
        hostelId,
        token: newToken(),
        updatedBy: principal.userId,
      })
    ).toObject() as LinkDoc;
  } catch (error) {
    // Two staff opening it at once: both get the one link.
    if ((error as { code?: number }).code !== 11000) throw error;

    return (await ResidentJoinLinkModel.findOne({ hostelId }).lean<LinkDoc | null>())!;
  }
}

async function linkView(link: LinkDoc): Promise<JoinLinkView> {
  const url = joinUrl(link.token);
  const [qrDataUrl, waiting] = await Promise.all([
    renderQr(url),
    ResidentApplicationModel.countDocuments({ hostelId: link.hostelId, status: "PENDING" }),
  ]);

  return { cap: link.cap, enabled: link.enabled, qrDataUrl, url, used: link.used, waiting };
}

export async function getJoinLink(hostelId: Types.ObjectId, principal: ApiPrincipal) {
  await connectToDatabase();

  return linkView(await ensureLink(hostelId, principal));
}

export async function updateJoinLink(
  hostelId: Types.ObjectId,
  input: { cap?: number; enabled?: boolean; renew?: true },
  principal: ApiPrincipal,
) {
  await connectToDatabase();
  await ensureLink(hostelId, principal);

  const link = await ResidentJoinLinkModel.findOneAndUpdate(
    { hostelId },
    {
      $set: {
        ...(input.cap !== undefined ? { cap: input.cap } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.renew ? { token: newToken() } : {}),
        updatedBy: principal.userId,
      },
    },
    { new: true },
  ).lean<LinkDoc | null>();

  return linkView(link!);
}

/* -------------------------------------------------------------------------- */
/* Checking a request — the existing-residents check, run on one row          */
/* -------------------------------------------------------------------------- */

function asRow(request: Pick<
  RequestDoc,
  "depositPaid" | "email" | "fullName" | "joinedDate" | "paidTill" | "partPaid" | "phone" | "roomType"
>): ListRow {
  return {
    depositPaid: request.depositPaid,
    email: request.email,
    fullName: request.fullName,
    id: "join",
    joinedDate: request.joinedDate ? new Date(request.joinedDate).toISOString() : null,
    monthlyRent: null,
    oldDues: 0,
    paidTill: request.paidTill,
    partPaid: request.partPaid,
    phone: request.phone,
    residentId: null,
    roomType: request.roomType,
  };
}

async function hostelRooms(hostelId: Types.ObjectId) {
  const hostel = await HostelModel.findOne({ _id: hostelId, isDeleted: { $ne: true } })
    .select("location.city name roomConfigurations")
    .lean<{
      location?: { city?: string };
      name?: string;
      roomConfigurations?: { roomType: string; vacantBeds?: number }[];
    } | null>();

  if (!hostel) {
    throw joinError("This hostel is no longer on the app.", "HOSTEL_NOT_FOUND", 404);
  }

  return { hostel, roomTypes: await roomTypesFor(hostelId, hostel.roomConfigurations ?? []) };
}

/**
 * The words a resident reads when their own request has a problem. The check
 * talks to a warden ("Set it in Fee schedule first"); these say what the
 * person sending can actually do about it.
 */
function forResident(field: RowField, message: string) {
  switch (field) {
    case "fullName":
      return "Your ID card needs your first and last name. Fix it on your ID card.";
    case "phone":
    case "email":
      return message.includes("already uses")
        ? "This hostel already has a resident with your phone or email. Ask them — you may be added already."
        : `${message} Fix it on your ID card.`;
    case "monthlyRent":
      return "The hostel has not set a rent for this room yet. Ask them, then send again.";
    default:
      return message;
  }
}

function toView(
  request: RequestDoc,
  checked: { bills: BillPreview | null; problems: string[]; rent: number | null },
  currentPeriod: string,
): JoinRequestView {
  return {
    bills: checked.bills,
    cardId: request.cardId,
    decidedAt: request.decidedAt ? new Date(request.decidedAt).toISOString() : null,
    depositPaid: request.depositPaid,
    email: request.email,
    fullName: request.fullName,
    id: request._id.toString(),
    joinedDate: request.joinedDate ? new Date(request.joinedDate).toISOString() : null,
    note: request.note ?? "",
    paidTill: request.paidTill,
    partPaid: request.partPaid,
    phone: request.phone,
    problems: checked.problems,
    rejectReason: request.rejectReason ?? "",
    rent: checked.rent,
    rentLabel: rentStatusLabel(currentPeriod, request.paidTill) ?? `Paid till ${monthLabel(request.paidTill)}`,
    residentId: request.residentId ? request.residentId.toString() : null,
    roomType: request.roomType,
    sends: request.sends,
    sentAt: new Date(request.sentAt).toISOString(),
    status: request.status,
  };
}

/* -------------------------------------------------------------------------- */
/* The person's side                                                          */
/* -------------------------------------------------------------------------- */

async function findLink(token: string) {
  const link = await ResidentJoinLinkModel.findOne({ token: token.trim() }).lean<LinkDoc | null>();

  if (!link) {
    throw joinError(
      "This link does not work any more. Ask your hostel for the new one.",
      "JOIN_LINK_NOT_FOUND",
      404,
    );
  }

  return link;
}

async function viewerFor(userId: string, hostelId: Types.ObjectId) {
  const { identity, profile } = await getResidentIdentity(userId);
  const email = (identity.accountEmail ?? profile?.primaryEmail ?? "").toLowerCase();
  const residency = await findLiveResidency(
    { emails: [identity.accountEmail, profile?.primaryEmail], userIds: [new Types.ObjectId(userId)] },
    hostelId,
  );

  return {
    card: (!identity.hasProfile || !identity.residentId
      ? "NONE"
      : identity.sharingEnabled === false
        ? "PRIVATE"
        : "READY") as "NONE" | "PRIVATE" | "READY",
    cardId: identity.residentId,
    email,
    fullName: profile?.fullName ?? identity.accountName ?? "",
    hasPhoto: identity.hasPhoto,
    livesAt: residency
      ? { hostelName: residency.hostelName, sameHostel: residency.sameHostel }
      : null,
    phone: profile?.primaryPhone ?? "",
    photoUpdatedAt: identity.photoUpdatedAt,
  };
}

export async function getJoinPage(token: string, userId: string | null): Promise<JoinPageView> {
  await connectToDatabase();

  const link = await findLink(token);
  const { hostel, roomTypes } = await hostelRooms(link.hostelId);
  const period = hostelPeriodOf(new Date());
  const viewer = userId ? await viewerFor(userId, link.hostelId) : null;
  const request = userId
    ? await ResidentApplicationModel.findOne({
        hostelId: link.hostelId,
        userId: new Types.ObjectId(userId),
      }).lean<RequestDoc | null>()
    : null;

  let requestView: JoinRequestView | null = null;

  if (request) {
    const row = asRow(request);
    const check = checkExistingResidents([row], await contextFor(link.hostelId, [row], roomTypes));
    const checked = check.rows[0]!;

    requestView = toView(
      request,
      { bills: checked.bills, problems: [], rent: checked.rent },
      period,
    );
  }

  return {
    currentMonth: { label: monthLabel(period), period },
    hostel: { city: hostel.location?.city ?? "", name: hostel.name ?? "" },
    link: linkState(link),
    request: requestView,
    roomTypes: roomTypes.map((room) => ({ monthlyRent: room.monthlyRent, roomType: room.roomType })),
    token: link.token,
    viewer,
  };
}

export async function sendJoinRequest(token: string, input: JoinRequestInput, userId: string) {
  await connectToDatabase();

  const link = await findLink(token);
  const hostelId = link.hostelId;
  const viewer = await viewerFor(userId, hostelId);

  if (viewer.card === "NONE") {
    throw joinError("Make your ID card first. The hostel checks you against it.", "JOIN_NEEDS_CARD");
  }

  if (viewer.card === "PRIVATE") {
    throw joinError(
      "Your ID card is set to private. Turn on sharing so the hostel can see it, then send.",
      "JOIN_CARD_PRIVATE",
    );
  }

  if (viewer.livesAt) {
    throw joinError(
      viewer.livesAt.sameHostel
        ? "You are already a resident here."
        : `You are still a resident of ${viewer.livesAt.hostelName}. They must move you out first.`,
      "JOIN_LIVES_SOMEWHERE",
      409,
    );
  }

  const { roomTypes } = await hostelRooms(hostelId);
  const room = roomTypes.find((candidate) => sameRoomType(candidate.roomType, input.roomType));

  if (!room) {
    throw joinError("Choose your room type from the list.", "JOIN_REQUEST_INVALID", 422, {
      field: "roomType",
    });
  }

  const fields = {
    cardId: viewer.cardId!,
    depositPaid: input.depositPaid,
    email: viewer.email,
    fullName: viewer.fullName.replace(/\s+/g, " ").trim(),
    joinedDate: input.joinedDate,
    note: input.note,
    paidTill: input.paidTill,
    partPaid: input.partPaid,
    phone: viewer.phone,
    roomType: room.roomType,
  };

  // The check that guards Add, run now so the person fixes it themself. Beds are
  // left out: a full room type is the hostel's to sort before pressing Add.
  const row = asRow(fields);
  const check = checkExistingResidents([row], await contextFor(hostelId, [row], roomTypes));
  const problem = check.rows[0]!.problems[0];

  if (problem) {
    throw joinError(forResident(problem.field, problem.message), "JOIN_REQUEST_INVALID", 422, {
      field: problem.field,
    });
  }

  const owner = new Types.ObjectId(userId);
  const existing = await ResidentApplicationModel.findOne({ hostelId, userId: owner }).lean<RequestDoc | null>();
  const now = new Date();
  let fresh = !existing || existing.status === "ADDED";
  let wasReturned = existing?.status === "REJECTED";

  if (existing && !fresh) {
    if (!link.enabled) {
      throw joinError("This hostel has paused its join link. Ask them.", "JOIN_LINK_OFF", 409);
    }

    if (existing.decidedAt && existing.status === "PENDING") {
      throw joinError("The hostel is adding you right now.", "JOIN_REQUEST_BUSY", 409);
    }

    await ResidentApplicationModel.updateOne(
      { _id: existing._id, status: { $in: ["PENDING", "REJECTED"] } },
      {
        $set: {
          ...fields,
          decidedAt: null,
          rejectReason: "",
          sentAt: now,
          status: "PENDING",
        },
        ...(wasReturned ? { $inc: { sends: 1 } } : {}),
      },
    );
  } else {
    // A new request uses up one place on the link, taken atomically so two
    // people sending the last place at once cannot both get it.
    const claimed = await ResidentJoinLinkModel.findOneAndUpdate(
      { _id: link._id, enabled: true, $expr: { $lt: ["$used", "$cap"] } },
      { $inc: { used: 1 } },
    );

    if (!claimed) {
      throw joinError(
        link.enabled
          ? "This link is full. Ask your hostel to allow more requests."
          : "This hostel has paused its join link. Ask them.",
        link.enabled ? "JOIN_LINK_FULL" : "JOIN_LINK_OFF",
        409,
      );
    }

    if (existing) {
      // Added once before, moved out since: a new request on the same record.
      await ResidentApplicationModel.updateOne(
        { _id: existing._id },
        {
          $set: {
            ...fields,
            decidedAt: null,
            decidedBy: null,
            linkId: link._id,
            rejectReason: "",
            residentId: null,
            sends: 1,
            sentAt: now,
            status: "PENDING",
          },
        },
      );
    } else {
      try {
        await ResidentApplicationModel.create({ ...fields, hostelId, linkId: link._id, userId: owner });
      } catch (error) {
        await ResidentJoinLinkModel.updateOne({ _id: link._id }, { $inc: { used: -1 } });

        if ((error as { code?: number }).code !== 11000) throw error;

        // Sent twice at once from two tabs — the first one stands.
        fresh = false;
        wasReturned = false;
      }
    }
  }

  // Staff hear about a new request and a fixed one — never about an edit to one they have not opened.
  if (fresh || wasReturned) {
    afterResponse(() =>
      tellStaff(hostelId, {
        fixed: wasReturned,
        name: fields.fullName,
        rent: rentStatusLabel(hostelPeriodOf(now), fields.paidTill) ?? "",
        roomType: fields.roomType,
      }),
    );
  }

  return getJoinPage(token, userId);
}

async function tellStaff(
  hostelId: Types.ObjectId,
  request: { fixed: boolean; name: string; rent: string; roomType: string },
) {
  try {
    const staff = await resolveHostelStaffUserIds(hostelId);

    await Promise.all(
      staff.map((userId) =>
        createInAppNotification({
          actionUrl: "/hostel-admin/residents",
          body: [request.roomType, request.rent, "Check and add"].filter(Boolean).join(" · "),
          category: "RESIDENT",
          hostelId: hostelId.toString(),
          title: request.fixed
            ? `${request.name} fixed their request to join`
            : `${request.name} asked to be added as a resident`,
          userId,
        }),
      ),
    );
  } catch (error) {
    logger.warn("Join request: staff were not told", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/* -------------------------------------------------------------------------- */
/* The hostel's side                                                          */
/* -------------------------------------------------------------------------- */

export async function listJoinRequests(hostelId: Types.ObjectId) {
  await connectToDatabase();

  const since = new Date(Date.now() - ADDED_SHOWN_DAYS * 24 * 60 * 60 * 1000);
  const requests = await ResidentApplicationModel.find({
    hostelId,
    $or: [{ status: { $in: ["PENDING", "REJECTED"] } }, { decidedAt: { $gte: since }, status: "ADDED" }],
  })
    .sort({ sentAt: -1 })
    .limit(300)
    .lean<RequestDoc[]>();

  const period = hostelPeriodOf(new Date());
  const { roomTypes } = await hostelRooms(hostelId);
  const pending = requests.filter((request) => request.status === "PENDING");
  const rows = pending.map(asRow);
  const context = rows.length ? await contextFor(hostelId, rows, roomTypes) : null;

  return {
    currentMonth: { label: monthLabel(period), period },
    requests: requests.map((request) => {
      if (request.status !== "PENDING" || !context) {
        return toView(request, { bills: null, problems: [], rent: null }, period);
      }

      // One at a time, so each is told about its own room's beds and nobody else's.
      const check = checkExistingResidents([asRow(request)], context);
      const checked = check.rows[0]!;

      return toView(
        request,
        {
          bills: checked.bills,
          problems: [...check.listProblems, ...checked.problems.map((problem) => problem.message)],
          rent: checked.rent,
        },
        period,
      );
    }),
    waiting: pending.length,
  };
}

async function findRequest(hostelId: Types.ObjectId, requestId: string) {
  if (!Types.ObjectId.isValid(requestId)) {
    throw joinError("That request was not found.", "JOIN_REQUEST_NOT_FOUND", 404);
  }

  const request = await ResidentApplicationModel.findOne({
    _id: new Types.ObjectId(requestId),
    hostelId,
  }).lean<RequestDoc | null>();

  if (!request) {
    throw joinError("That request was not found.", "JOIN_REQUEST_NOT_FOUND", 404);
  }

  return request;
}

function alreadyAnswered(request: RequestDoc) {
  return joinError(
    request.status === "ADDED"
      ? `${request.fullName} is already added.`
      : `${request.fullName}'s request was sent back. It comes here again when they fix it.`,
    "JOIN_REQUEST_ANSWERED",
    409,
  );
}

/** Add — the scan desk's "Add as existing resident", for the person on the card. */
export async function addJoinRequest(
  hostelId: Types.ObjectId,
  requestId: string,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const request = await findRequest(hostelId, requestId);

  if (request.status !== "PENDING") throw alreadyAnswered(request);

  const now = new Date();
  const locked = await ResidentApplicationModel.findOneAndUpdate(
    {
      _id: request._id,
      status: "PENDING",
      $or: [{ decidedAt: null }, { decidedAt: { $lt: new Date(now.getTime() - ADD_LOCK_MS) } }],
    },
    { $set: { decidedAt: now, decidedBy: principal.userId } },
  );

  if (!locked) {
    throw joinError("Someone is adding them right now.", "JOIN_REQUEST_BUSY", 409);
  }

  try {
    const added = await addScannedExistingResident(
      hostelId,
      {
        depositPaid: request.depositPaid,
        email: request.email,
        fullName: request.fullName,
        joinedDate: request.joinedDate ?? null,
        monthlyRent: null,
        oldDues: 0,
        paidTill: request.paidTill,
        partPaid: request.partPaid,
        phone: request.phone,
        roomType: request.roomType,
      },
      request.cardId,
      principal,
    );

    await ResidentApplicationModel.updateOne(
      { _id: request._id },
      {
        $set: {
          decidedAt: new Date(),
          decidedBy: principal.userId,
          residentId: added.residentId ? new Types.ObjectId(added.residentId) : null,
          status: "ADDED",
        },
      },
    );

    return { residentId: added.residentId, result: added.result };
  } catch (error) {
    await ResidentApplicationModel.updateOne(
      { _id: request._id, status: "PENDING" },
      { $set: { decidedAt: null } },
    );

    throw error;
  }
}

/** Send back — they see why, fix it on the same link, and it comes back as the same request. */
export async function returnJoinRequest(
  hostelId: Types.ObjectId,
  requestId: string,
  reason: string,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const request = await findRequest(hostelId, requestId);
  const returned = await ResidentApplicationModel.findOneAndUpdate(
    { _id: request._id, decidedAt: null, status: "PENDING" },
    {
      $set: {
        decidedAt: new Date(),
        decidedBy: principal.userId,
        rejectReason: reason,
        status: "REJECTED",
      },
    },
  );

  if (!returned) {
    throw request.status === "PENDING"
      ? joinError("Someone is adding them right now.", "JOIN_REQUEST_BUSY", 409)
      : alreadyAnswered(request);
  }

  afterResponse(() => tellReturned(request, reason));

  return { ok: true };
}

async function tellReturned(request: RequestDoc, reason: string) {
  try {
    const [link, hostel] = await Promise.all([
      ResidentJoinLinkModel.findOne({ hostelId: request.hostelId }).select("token").lean<{ token: string } | null>(),
      HostelModel.findById(request.hostelId).select("name").lean<{ name?: string } | null>(),
    ]);
    const hostelName = hostel?.name?.trim() || "Your hostel";
    const path = link ? `/join/${link.token}` : "/";

    await createInAppNotification({
      actionUrl: path,
      body: `${reason} — fix it and send again.`,
      category: "ACCOUNT",
      priority: "HIGH",
      title: `${hostelName} sent your request back`,
      userId: request.userId.toString(),
    });

    if (request.email) {
      const email = joinRequestReturnedEmail({
        fixUrl: `${outboundUrl()}${path}`,
        hostelName,
        reason,
        residentName: request.fullName.split(" ")[0] ?? request.fullName,
      });

      await sendNotificationEmail({
        action: "join_request_returned",
        html: email.html,
        subject: email.subject,
        to: request.email,
      });
    }
  } catch (error) {
    logger.warn("Join request: sent back, but the person was not told", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
