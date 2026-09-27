import { Types } from "mongoose";
import type { z } from "zod";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { REALTIME_TOPIC } from "@/lib/realtime/channels";
import { publishResourceChange } from "@/lib/realtime/server";
import { Role } from "@/lib/roles";
import { HOSTEL_UTC_OFFSET_MINUTES, hostelToday } from "@/lib/hostel-day";
import { assertHostelAccess } from "@/lib/tenant";
import {
  CookServiceError as CookError,
  resolveAdminHostelId,
} from "@/modules/food/cook-scope";
import {
  issueCredentialCook,
  resolveCookLabels,
} from "@/modules/food/cook-roster.service";
import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { FoodPhotoModel } from "@hostel/db/models/FoodPhoto";
import { FoodReadyLogModel } from "@hostel/db/models/FoodReadyLog";
import { HostelModel } from "@hostel/db/models/Hostel";
import { CookAccountModel } from "@hostel/db/models/CookAccount";
import { HostelSettingsModel } from "@hostel/db/models/HostelSettings";
import { UserModel } from "@hostel/db/models/User";
import { ResidentModel } from "@hostel/db/models/Resident";
import { coveredMealCount, groupPhotosByDay } from "@/modules/food/food-photo-days";
import { getFoodRoutine, mealsOn } from "@/modules/food/food-routine.service";
import { uploadFoodPhoto } from "@/modules/food/food.service";
import { notifyFoodReady } from "@/modules/food/food-ready-notify";
import { getOperationsConfig } from "@/modules/platform-config/operations-config";
import { normalizeObjectId } from "@/modules/residents/resident-access";
import {
  appUrl,
  resolveHostelAdminContacts,
  sendNotificationEmail,
} from "@/modules/residents/resident-notify";
import {
  formatMinuteOfDay,
  mealAnnounceState,
  mealClosesAtMinute,
  mealOpensAtMinute,
  nepalMinuteOfDay,
} from "@hostel/shared/food/meal-window";
import { cookPortalEnabledEmail } from "@hostel/shared/email/templates/hostel/cook-portal-enabled";
import type {
  cookPortalUpdateSchema,
  foodReadySchema,
} from "@/modules/food/cook.validation";
import type { foodPhotoUploadSchema } from "@/modules/food/food.validation";

type CookPortalUpdateInput = z.infer<typeof cookPortalUpdateSchema>;
type FoodReadyInput = z.infer<typeof foodReadySchema>;
type FoodPhotoUploadInput = z.infer<typeof foodPhotoUploadSchema>;

type HostelSettingsRecord = {
  _id: Types.ObjectId;
  cookCredentialIssuedAt?: Date;
  cookName?: string;
  cookPortalEnabled: boolean;
  cookUserId?: Types.ObjectId;
  hostelId: Types.ObjectId;
};

/**
 * Both live in `cook-scope.ts` now — the roster needs them too, and this file
 * imports the roster, so leaving them here would have closed the cycle.
 */
export { CookServiceError } from "@/modules/food/cook-scope";

function serializeSettings(
  settings: HostelSettingsRecord | null,
  cookAccount?: { email?: string; mustChangePassword?: boolean } | null,
) {
  return {
    /** The stable login, safe to show in the dashboard — the password is not. */
    cookEmail: cookAccount?.email ?? "",
    cookName: settings?.cookName ?? "",
    cookPortalEnabled: Boolean(settings?.cookPortalEnabled),
    cookUserId: settings?.cookUserId?.toString(),
    credentialIssuedAt: settings?.cookCredentialIssuedAt?.toISOString(),
    /**
     * True while the emailed hand-off password is still unused. Once a cook
     * sets their own, only its bcrypt hash exists — nobody, including the
     * hostel admin, can read it back; recovery is a rotation.
     */
    initialPasswordPending: Boolean(cookAccount?.mustChangePassword),
  };
}

/**
 * Issues a hostel its **first** cook login and turns the portal on.
 *
 * Kept as its own entry point because that is what hostel approval calls: a
 * hostel that has just been approved has no roster yet, and the owner should
 * find a working kitchen login in their inbox rather than an empty screen.
 *
 * It is no longer the rotate path and no longer upserts by address — adding,
 * renaming, rotating and removing cooks all live in `cook-roster.service.ts`,
 * which this delegates the account minting to. Calling it twice mints two
 * cooks, so `updateCookPortal` checks the roster before it calls.
 */
export async function provisionCookAccount(input: {
  actorId: string;
  cookName?: string;
  hostelId: Types.ObjectId;
  hostelName: string;
  hostelSlug: string;
}) {
  const cookName = input.cookName ?? `${input.hostelName} Cook`;
  const { credentials } = await issueCredentialCook({
    actorId: input.actorId,
    cookName,
    hostelId: input.hostelId,
    hostelName: input.hostelName,
    hostelSlug: input.hostelSlug,
  });

  // `issueCredentialCook` writes the roster row and re-points the primary; the
  // portal switch is this function's own business because it is what "provision
  // a cook" has always meant to its callers.
  const settings = await HostelSettingsModel.findOneAndUpdate(
    { hostelId: input.hostelId },
    {
      $set: {
        cookPortalEnabled: true,
        hostelId: input.hostelId,
        updatedBy: input.actorId,
      },
    },
    { new: true, setDefaultsOnInsert: true, upsert: true },
  ).lean<HostelSettingsRecord | null>();

  return { cookName, credentials, settings };
}

/** Loads the cook User behind a settings row, for read-only status display. */
async function loadCookAccount(settings: HostelSettingsRecord | null) {
  if (!settings?.cookUserId) {
    return null;
  }

  return UserModel.findOne({ _id: settings.cookUserId })
    .select("email mustChangePassword")
    .lean<{ email?: string; mustChangePassword?: boolean } | null>();
}

export async function getCookPortalSettings(
  principal: ApiPrincipal,
  requestedHostelId?: string,
) {
  await connectToDatabase();

  const hostelId = resolveAdminHostelId(principal, requestedHostelId);
  const settings = await HostelSettingsModel.findOne({
    hostelId,
  }).lean<HostelSettingsRecord | null>();
  const cookAccount = await loadCookAccount(settings);

  return { settings: serializeSettings(settings, cookAccount) };
}

export async function updateCookPortal(
  input: CookPortalUpdateInput,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const hostelId = resolveAdminHostelId(principal, input.hostelId);
  const hostel = await HostelModel.findOne({ _id: hostelId })
    .select("name slug")
    .lean<{ name?: string; slug?: string } | null>();

  if (!hostel) {
    throw new CookError("Hostel was not found.", "HOSTEL_NOT_FOUND", 404);
  }

  const existing = await HostelSettingsModel.findOne({
    hostelId,
  }).lean<HostelSettingsRecord | null>();

  if (!input.enabled) {
    // Every cook on the roster, not just the one `cookUserId` happens to name.
    // The switch means "the kitchen is closed"; suspending one of three logins
    // and leaving the other two working would be a switch that lies.
    const live = await CookAccountModel.find({
      hostelId,
      status: "ACTIVE",
      userId: { $ne: null },
    })
      .select("userId")
      .lean<{ userId?: Types.ObjectId }[]>();
    const userIds = live
      .map((cook) => cook.userId)
      .filter((userId): userId is Types.ObjectId => Boolean(userId));

    if (userIds.length > 0) {
      await UserModel.updateMany(
        { _id: { $in: userIds } },
        { $set: { status: "SUSPENDED", updatedBy: principal.userId } },
      );
    }

    const settings = await HostelSettingsModel.findOneAndUpdate(
      { hostelId },
      {
        $set: {
          cookPortalEnabled: false,
          hostelId,
          updatedBy: principal.userId,
        },
      },
      { new: true, setDefaultsOnInsert: true, upsert: true },
    ).lean<HostelSettingsRecord | null>();

    await AuditLogModel.create({
      action: "COOK_PORTAL_DISABLED",
      actorId: principal.userId,
      entityId: hostelId.toString(),
      entityType: "HostelSettings",
      hostelId,
    });

    return { credentialsIssued: false, settings: serializeSettings(settings) };
  }

  // Enabling is a switch, not a mint.
  //
  // It used to call `provisionCookAccount` unconditionally, which was safe only
  // while a hostel could have exactly one cook: the upsert landed on the same
  // address every time and rotated its password. With a roster, that same call
  // would add a *new* cook on every toggle — three flips of a switch, three
  // logins — so a hostel that already has cooks gets its existing ones woken up
  // instead, and only an empty roster is issued a first login.
  //
  // Rotating a password is `PATCH /hostel-admin/cooks/{id}` with `rotate`. This
  // endpoint no longer does it, because "turn the portal back on" and "the
  // password leaked" are not the same request.
  const roster = await CookAccountModel.find({
    hostelId,
    status: { $in: ["ACTIVE", "INVITED"] },
  })
    .sort({ createdAt: 1 })
    .lean<{ _id: Types.ObjectId; name: string; userId?: Types.ObjectId }[]>();

  if (roster.length > 0) {
    const userIds = roster
      .map((cook) => cook.userId)
      .filter((userId): userId is Types.ObjectId => Boolean(userId));

    if (userIds.length > 0) {
      await UserModel.updateMany(
        { _id: { $in: userIds }, isDeleted: { $ne: true } },
        { $set: { status: "ACTIVE", updatedBy: principal.userId } },
      );
    }

    if (input.cookName && roster[0]) {
      await CookAccountModel.updateOne(
        { _id: roster[0]._id },
        { $set: { name: input.cookName, updatedBy: principal.userId } },
      );

      if (roster[0].userId) {
        await UserModel.updateOne(
          { _id: roster[0].userId },
          { $set: { name: input.cookName, updatedBy: principal.userId } },
        );
      }
    }

    const settings = await HostelSettingsModel.findOneAndUpdate(
      { hostelId },
      {
        $set: {
          cookName: input.cookName ?? roster[0]?.name ?? existing?.cookName ?? "",
          cookPortalEnabled: true,
          hostelId,
          updatedBy: principal.userId,
        },
      },
      { new: true, setDefaultsOnInsert: true, upsert: true },
    ).lean<HostelSettingsRecord | null>();

    await AuditLogModel.create({
      action: "COOK_PORTAL_ENABLED",
      actorId: principal.userId,
      entityId: hostelId.toString(),
      entityType: "HostelSettings",
      hostelId,
      metadata: { cookCount: roster.length, reactivated: true },
    });

    return {
      credentialsIssued: false,
      settings: serializeSettings(settings, await loadCookAccount(settings)),
    };
  }

  const { cookName, credentials, settings } = await provisionCookAccount({
    actorId: principal.userId,
    cookName: input.cookName ?? existing?.cookName,
    hostelId,
    hostelName: hostel.name ?? "Hostel",
    hostelSlug: hostel.slug ?? hostelId.toString(),
  });
  const { email, temporaryPassword } = credentials;

  await AuditLogModel.create({
    action: "COOK_PORTAL_ENABLED",
    actorId: principal.userId,
    entityId: hostelId.toString(),
    entityType: "HostelSettings",
    hostelId,
    metadata: { cookName },
  });

  const admins = await resolveHostelAdminContacts(hostelId);
  const message = cookPortalEnabledEmail({
    cookName,
    credentials: { email, temporaryPassword },
    hostelName: hostel.name ?? "your hostel",
    loginUrl: appUrl("/login"),
  });

  await Promise.all(
    admins.map((admin) =>
      sendNotificationEmail({
        action: "cook_portal_enabled",
        html: message.html,
        subject: message.subject,
        to: admin.email,
      }),
    ),
  );

  return {
    /** Returned once so the admin can hand it over if the email never lands. */
    credentials: { email, temporaryPassword },
    credentialsIssued: true,
    settings: serializeSettings(settings, { email, mustChangePassword: true }),
  };
}

async function resolveCookHostelId(principal: ApiPrincipal, requestedHostelId?: string) {
  if (principal.role === Role.COOK) {
    const hostelId = requestedHostelId ?? principal.hostelIds[0];

    if (!hostelId) {
      throw new CookError(
        "This cook account is not linked to a hostel.",
        "HOSTEL_SCOPE_REQUIRED",
        422,
      );
    }

    assertHostelAccess(principal, hostelId);

    return normalizeObjectId(hostelId, "hostel id");
  }

  return resolveAdminHostelId(principal, requestedHostelId);
}

/**
 * The instant today began in Kathmandu — 18:15 UTC the evening before. Local
 * `setHours` on a UTC server started the day at 05:45, so a breakfast called at
 * 05:30 dropped off the cook's list and its button lit up again.
 */
function startOfToday() {
  return new Date(hostelToday().getTime() - HOSTEL_UTC_OFFSET_MINUTES * 60_000);
}

/**
 * "Food Ready" announcement (PHASES.md §3.1 Cook Portal).
 *
 * Writes the log row, then hands the whole fan-out to `notifyFoodReady`:
 * residents get the menu at `HIGH` priority in one batched Expo send, and the
 * hostel's own staff get a separate line naming the time, the reach and the
 * handset. The comment this replaced said push delivery "arrives with the
 * mobile app in Phase 6" — the app shipped, and this was still the one
 * time-critical notification in the product going out at default priority, one
 * Expo round trip per resident.
 *
 * ## Two guards, and they are different rules
 *
 * **Outside its window** (409, two codes). A meal cannot be called before the
 * hostel's own routine serves it, give or take the half-hour lead
 * `meal-window.ts` allows for a kitchen running early — nor after an hour past
 * the end of service, by which point the meal has gone out unannounced and the
 * honest record is that nobody called it. `MEAL_NOT_DUE` and
 * `MEAL_WINDOW_CLOSED` are separate codes because they are opposite facts. The cook's four
 * cards are identical but for a heading and are used one-handed over a pot, so
 * a mis-tap pushes dinner's menu to every resident at breakfast — and the
 * cooldown below then blocks the correction. The app disables the button from
 * this same `@hostel/shared/food/meal-window` decision, which is why it lives
 * in a package both ends import rather than being restated here: a gate the
 * client draws and the server does not enforce is not a gate, and one the
 * server enforces and the client does not draw is a button that lies.
 *
 * It applies to an admin announcing from the web portal too, not just to a cook.
 * The routine's serving times are the office's own, editable in one screen, and
 * a rule that a hostel can hold two opinions about is not a rule.
 *
 * **Too soon after the last one** (429) is the cooldown, below — a different
 * concern with a different fix, and the reason this one is a 409.
 */
export async function announceFoodReady(input: FoodReadyInput, principal: ApiPrincipal) {
  await connectToDatabase();

  const hostelId = await resolveCookHostelId(principal, input.hostelId);
  const today = startOfToday();

  /*
   * Loaded once, unconditionally. It used to be fetched only to build the
   * message; the serving times on it now decide whether the announcement is
   * allowed at all, so the read is no longer optional.
   */
  const routine = await getFoodRoutine(hostelId);

  /*
   * The hostel's clock for this meal — off `timings`, which is per meal for the
   * whole week, rather than off today's row. A hostel that serves no Friday
   * snack still has a snack time, and an unplanned Friday snack is still a
   * snack rather than something announceable at dawn.
   */
  const timing = routine.timings[input.mealType] ?? "";

  const state = mealAnnounceState(timing, nepalMinuteOfDay());

  if (state === "EARLY") {
    const opensAt = mealOpensAtMinute(timing);

    throw new CookError(
      `${input.mealType.toLowerCase()} is not due yet. It can be announced from ${formatMinuteOfDay(opensAt ?? 0)}.`,
      "MEAL_NOT_DUE",
      409,
    );
  }

  /*
   * The other end of the same window. Separate from `MEAL_NOT_DUE` because the
   * two are opposite facts and a client that cannot tell them apart cannot
   * write the right words on the button — the app draws "Opens 5:30 AM" for one
   * and "Not announced in time" for the other.
   */
  if (state === "MISSED") {
    const closesAt = mealClosesAtMinute(timing);

    throw new CookError(
      `${input.mealType.toLowerCase()} was not announced in time — it could be called until ${formatMinuteOfDay(closesAt ?? 0)}. Ask the office to change the serving time if it has moved.`,
      "MEAL_WINDOW_CLOSED",
      409,
    );
  }

  // The routine repeats weekly, so today's meal is today's weekday entry.
  const menu = input.useMenuDescription
    ? mealsOn(routine, today).find((meal) => meal.mealType === input.mealType)
    : null;

  const mealLabel = input.mealType.toLowerCase();
  const body =
    input.message ??
    (menu?.items?.length
      ? `Today's ${mealLabel}: ${menu.items.join(", ")}`
      : `${mealLabel.charAt(0).toUpperCase()}${mealLabel.slice(1)} is ready.`);

  // Cook credentials are shared kitchen-wide and effectively static, so treat
  // "announce" as the one abusable action: a cooldown caps how much noise a
  // leaked login (or a mis-tapping cook) can push to every resident at once.
  const { foodReadyCooldownMinutes } = await getOperationsConfig();

  if (foodReadyCooldownMinutes > 0) {
    const cooldownStart = new Date(Date.now() - foodReadyCooldownMinutes * 60 * 1000);
    const recent = await FoodReadyLogModel.findOne({
      announcedAt: { $gte: cooldownStart },
      hostelId,
      mealType: input.mealType,
    })
      .sort({ announcedAt: -1 })
      .lean<{ announcedAt: Date } | null>();

    if (recent) {
      const waitMinutes = Math.max(
        1,
        Math.ceil(
          (recent.announcedAt.getTime() +
            foodReadyCooldownMinutes * 60 * 1000 -
            Date.now()) /
            60_000,
        ),
      );

      throw new CookError(
        `${input.mealType.toLowerCase()} was already announced recently. Try again in ${waitMinutes} minute(s).`,
        "FOOD_READY_COOLDOWN",
        429,
      );
    }
  }

  const announcedAt = new Date();

  /*
   * Residents and the office, in one call — see `food-ready-notify.ts` for why
   * the two audiences get different words and different priorities, and why the
   * push is one batched send rather than one per resident.
   */
  const { notifiedCount, staffNotifiedCount } = await notifyFoodReady({
    announcedAt,
    createdBy: principal.userId,
    deviceInfo: input.deviceInfo,
    hostelId,
    mealLabel,
    mealType: input.mealType,
    message: body,
  });

  const log = await FoodReadyLogModel.create({
    announcedAt,
    announcedBy: principal.userId,
    deviceInfo: input.deviceInfo,
    hostelId,
    mealType: input.mealType,
    message: body,
    notifiedCount,
  });

  await AuditLogModel.create({
    action: "FOOD_READY_ANNOUNCED",
    actorId: principal.userId,
    entityId: log._id.toString(),
    entityType: "FoodReadyLog",
    hostelId,
    metadata: { mealType: input.mealType, notifiedCount, staffNotifiedCount },
  });

  // "Food is ready" is time-critical and goes to the whole hostel — including
  // residents with no account, whose food screen would otherwise wait out a
  // poll interval before showing it.
  await publishResourceChange({
    hostelIds: [hostelId.toString()],
    topics: [REALTIME_TOPIC.FOOD],
  });

  return {
    announcement: {
      announcedAt: log.announcedAt.toISOString(),
      id: log._id.toString(),
      mealType: input.mealType,
      message: body,
      notifiedCount,
      /*
       * Reported back so the cook's toast can say the office was told as well.
       * A kitchen that knows the warden got the same ping is a kitchen that
       * stops phoning the office to check the app worked.
       */
      staffNotifiedCount,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Cook-scoped reads                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Everything a cook needs to start a shift, in one request.
 *
 * ## Why this exists at all
 *
 * Until now the cook had exactly one endpoint — `POST /cook/food-ready` — and
 * the reads a kitchen actually needs sat under `hostel-admin/food/routine`
 * behind `requireHostelCapability("manageFood")`, which is `HOSTEL_ADMIN` or
 * `WARDEN` only. A cook is neither. So the person cooking the meal could
 * announce it but could not look up what it was, or how many people to cook
 * for. That was tracked as server gap #3 in MOBILE_APP_PHASES.md §1.
 *
 * ## Scope, and what is deliberately not returned
 *
 * `resolveCookHostelId` already handles both audiences: a COOK is pinned to the
 * hostel on their principal, and hostel staff may pass one explicitly. So this
 * is safe to expose to the shared kitchen login *and* useful to an admin
 * previewing what the cook sees.
 *
 * `residentCount` is a **number**, not a list. A cook needs to know how many
 * plates; nothing about the kitchen's job requires knowing whose. The names are
 * a separate, narrower endpoint below, and even that returns no contact details.
 *
 * `announced` is today's `FoodReadyLog` rows, so the four buttons can show
 * which meals have already gone out — the cooldown is enforced server-side and
 * a button that 429s after the fact is a worse way to learn that.
 */
export async function getCookToday(principal: ApiPrincipal, requestedHostelId?: string) {
  await connectToDatabase();

  const hostelId = await resolveCookHostelId(principal, requestedHostelId);
  const today = startOfToday();

  const [hostel, routine, residentCount, announcements] = await Promise.all([
    HostelModel.findOne({ _id: hostelId, isDeleted: false })
      /*
       * The listing fields as well as the name, so the kitchen's header can
       * offer the hostel's public page. `slug` alone is not enough to decide
       * that: `getPublicHostelBySlug` filters on PUBLISHED **and** VERIFIED, so
       * a hostel mid-application has a slug that answers with a 404.
       */
      .select("name slug status verificationStatus")
      .lean<{
        _id: Types.ObjectId;
        name: string;
        slug?: string;
        status?: string;
        verificationStatus?: string;
      } | null>(),
    getFoodRoutine(hostelId),
    /*
     * Every ACTIVE resident, which is plates to cook — deliberately a wider
     * filter than the announcement's audience (`food-ready-notify.ts`), which
     * additionally requires an account to notify. The two numbers are meant to
     * differ, and the difference is how many residents have not installed the
     * app; the comment that used to sit here claimed they agreed, which was
     * never true.
     */
    ResidentModel.countDocuments({ hostelId, isDeleted: false, status: "ACTIVE" }),
    FoodReadyLogModel.find({ announcedAt: { $gte: today }, hostelId })
      .sort({ announcedAt: -1 })
      .limit(12)
      .lean<
        {
          _id: Types.ObjectId;
          announcedAt: Date;
          mealType: string;
          message?: string;
          notifiedCount: number;
        }[]
      >(),
  ]);

  return {
    today: {
      announced: announcements.map((log) => ({
        announcedAt: log.announcedAt.toISOString(),
        id: log._id.toString(),
        mealType: log.mealType,
        message: log.message ?? "",
        notifiedCount: log.notifiedCount,
      })),
      date: hostelToday().toISOString().slice(0, 10),
      hostel: hostel
        ? {
            id: hostel._id.toString(),
            name: hostel.name,
            /*
             * `""` unless the listing is genuinely live — the same gate the
             * guardian and resident dashboards apply, and the reason the client
             * needs no copy of the rule. A cook handed a slug that 404s learns
             * nothing except that the app is broken.
             */
            slug:
              hostel.status === "PUBLISHED" &&
              hostel.verificationStatus === "VERIFIED" &&
              hostel.slug
                ? hostel.slug
                : "",
          }
        : { id: hostelId.toString(), name: "Your hostel", slug: "" },
      /** Today's weekday entries off the weekly routine, in meal order. */
      meals: mealsOn(routine, today),
      /** The whole week, so the menu screen needs no second request. */
      routine,
      residentCount,
    },
  };
}

/**
 * The roster, reduced to what a kitchen has any business seeing.
 *
 * Name, room type and status — no phone, no email, no deposit, no move-in date,
 * no account linkage. The cook login is **shared kitchen-wide** and effectively
 * static (`provisionCookAccount` issues one password per hostel), so this is the
 * one endpoint in the product where a leaked credential hands a stranger a list
 * of residents. Keeping it to a name and a room means that list is worth
 * nothing beyond what a noticeboard already shows.
 *
 * ACTIVE only: someone who has moved out is not eating here.
 */
export async function listCookResidents(
  principal: ApiPrincipal,
  requestedHostelId?: string,
) {
  await connectToDatabase();

  const hostelId = await resolveCookHostelId(principal, requestedHostelId);
  const residents = await ResidentModel.find({
    hostelId,
    isDeleted: false,
    status: "ACTIVE",
  })
    .select("firstName lastName roomType")
    .sort({ firstName: 1, lastName: 1 })
    .limit(500)
    .lean<
      { _id: Types.ObjectId; firstName: string; lastName: string; roomType: string }[]
    >();

  return {
    residents: residents.map((resident) => ({
      fullName: `${resident.firstName} ${resident.lastName}`.trim(),
      id: resident._id.toString(),
      roomType: resident.roomType,
    })),
  };
}

/**
 * A photo of the meal, straight from the kitchen.
 *
 * Delegates to `uploadFoodPhoto` rather than writing its own `FoodPhoto` —
 * that function owns the audit row and the realtime publish that makes the
 * photo appear on residents' food screens — and hands it the hostel this cook
 * is scoped to, because `resolveAdminHostelId` inside it would refuse a COOK
 * principal outright.
 */
export async function uploadCookFoodPhoto(
  input: FoodPhotoUploadInput,
  principal: ApiPrincipal,
) {
  const hostelId = await resolveCookHostelId(principal, input.hostelId);

  return uploadFoodPhoto(input, principal, { hostelId });
}

type CookFoodPhotoRecord = {
  _id: Types.ObjectId;
  caption?: string;
  date: Date;
  mealType: string;
  photoAssetId: string;
  residentId?: Types.ObjectId;
  uploadedAt: Date;
  uploadedBy?: Types.ObjectId;
};

/**
 * How many photos the kitchen's own feed reaches back over.
 *
 * Four meals a day plus the occasional resident post is roughly 5–8 rows a day,
 * so 120 is about a fortnight — long enough to answer "did we post anything on
 * Tuesday" and short enough that the response stays small on a kitchen tablet
 * over a hostel's wifi. The cap is on **photos**, not days, because a day with
 * thirty photos is exactly the case a day-based limit would blow up on.
 */
const COOK_PHOTO_LIMIT = 120;

/**
 * The page boundary, as the two fields the feed is actually sorted by.
 *
 * Opaque to the client on purpose — it is handed back verbatim and never
 * constructed — but it is only a sort key, so a malformed or hostile one can do
 * nothing worse than start the page somewhere else in this hostel's own feed.
 * `hostelId` is resolved from the principal either way and is never in here.
 */
function encodePhotoCursor(photo: { date: Date; uploadedAt: Date }) {
  return `${photo.date.toISOString()}|${photo.uploadedAt.toISOString()}`;
}

function decodePhotoCursor(cursor?: string) {
  if (!cursor) {
    return null;
  }

  const [date, uploadedAt] = cursor.split("|");
  const parsedDate = new Date(date ?? "");
  const parsedUploadedAt = new Date(uploadedAt ?? "");

  // A cursor that will not parse is treated as no cursor: the cook gets the
  // first page again, which is a visibly wrong-but-harmless result, rather than
  // a 500 on a feed they were merely scrolling.
  return Number.isNaN(parsedDate.getTime()) || Number.isNaN(parsedUploadedAt.getTime())
    ? null
    : { date: parsedDate, uploadedAt: parsedUploadedAt };
}

/**
 * The kitchen's own view of the photo feed, grouped by day.
 *
 * ## Why this route did not exist until now
 *
 * `/cook/food-photos` was POST-only. A cook could post a photo of dinner and had
 * no way to see it, or to see whether anyone had posted at all today — while
 * every resident in the hostel could. There was no reason for that beyond nobody
 * having written the GET.
 *
 * ## Days come from `Asia/Kathmandu`, not from UTC
 *
 * See `food-photo-days.ts`. A breakfast photographed at 05:30 local is
 * `23:45Z` the previous day; grouped by UTC it lands under the day before and
 * the kitchen quietly stops trusting the screen.
 *
 * ## `source`, not `uploadedBy`
 *
 * The cook login is shared kitchen-wide, so `uploadedBy` is the same user for
 * every cook in the building and cannot answer "who posted this". What it *can*
 * answer honestly is **kitchen or resident**, which is the distinction the
 * screen actually needs — a resident's photo of their plate is not the
 * kitchen's record of the meal.
 */
export async function listCookFoodPhotos(
  principal: ApiPrincipal,
  requestedHostelId?: string,
  cursor?: string,
) {
  await connectToDatabase();

  const hostelId = await resolveCookHostelId(principal, requestedHostelId);

  const after = decodePhotoCursor(cursor);

  const photos = await FoodPhotoModel.find({
    hostelId,
    ...(after
      ? {
          /*
           * The sort key, read back as a filter. `date` leads and `uploadedAt`
           * breaks its ties, so "everything after this row" is "an earlier day,
           * or the same day posted earlier" — a `skip` would instead re-send or
           * silently drop a photo whenever the kitchen posts one while a cook is
           * paging, which on this feed is most of the time.
           */
          $or: [
            { date: { $lt: after.date } },
            { date: after.date, uploadedAt: { $lt: after.uploadedAt } },
          ],
        }
      : {}),
  })
    // Same order the resident feed uses: the meal's own date leads, and
    // `uploadedAt` breaks ties within a day so two lunches read in the order
    // they were actually posted.
    .sort({ date: -1, uploadedAt: -1 })
    .limit(COOK_PHOTO_LIMIT)
    .lean<CookFoodPhotoRecord[]>();

  // Same roster lookup the announcement log uses. Only kitchen photos carry a
  // cook name — a resident's photo of their own plate is attributed to nobody,
  // which is what `source: "RESIDENT"` already says.
  const labels = await resolveCookLabels(
    hostelId,
    photos.filter((photo) => !photo.residentId).map((photo) => photo.uploadedBy),
  );

  const serialized = photos.map((photo) => ({
    caption: photo.caption ?? "",
    cookName:
      !photo.residentId && photo.uploadedBy
        ? (labels.get(photo.uploadedBy.toString()) ?? "")
        : "",
    date: photo.date,
    id: photo._id.toString(),
    mealType: photo.mealType,
    photoAssetId: photo.photoAssetId,
    source: photo.residentId ? ("RESIDENT" as const) : ("KITCHEN" as const),
    uploadedAt: photo.uploadedAt,
  }));

  const days = groupPhotosByDay(serialized).map((entry) => ({
    day: entry.day,
    /** Distinct meals covered, which is what "did we document today" means. */
    mealsCovered: coveredMealCount(entry.photos),
    photos: entry.photos.map((photo) => ({
      ...photo,
      date: photo.date.toISOString(),
      uploadedAt: photo.uploadedAt.toISOString(),
    })),
  }));

  const last = photos.at(-1);

  return {
    /**
     * Where the next page starts. `null` at the end of the feed, so a client
     * asks for another page if and only if the server has said there is one.
     */
    cursor: photos.length === COOK_PHOTO_LIMIT && last ? encodePhotoCursor(last) : null,
    days,
    /** Whether the cap was hit, so a client knows the feed is not the whole history. */
    hasMore: photos.length === COOK_PHOTO_LIMIT,
    total: photos.length,
  };
}

/** Recent announcements, for the cook dashboard and food-timing reports. */
export async function listFoodReadyLogs(
  principal: ApiPrincipal,
  requestedHostelId?: string,
) {
  await connectToDatabase();

  const hostelId = await resolveCookHostelId(principal, requestedHostelId);
  const logs = await FoodReadyLogModel.find({ hostelId })
    .sort({ announcedAt: -1 })
    .limit(50)
    .lean<
      {
        _id: Types.ObjectId;
        announcedAt: Date;
        announcedBy?: Types.ObjectId;
        mealType: string;
        message?: string;
        notifiedCount: number;
      }[]
    >();

  // Who announced it, resolved through the roster rather than joined to
  // `User.name`. A cook who has left has no account left to join to, and this
  // is the read where that shows: their announcements keep the name the roster
  // froze for them ("Previous Sunrise cook") instead of going blank or, worse,
  // inheriting the name of whoever holds the kitchen login today.
  const labels = await resolveCookLabels(
    hostelId,
    logs.map((log) => log.announcedBy),
  );

  return {
    logs: logs.map((log) => ({
      announcedAt: log.announcedAt.toISOString(),
      /** Empty when the announcement predates the roster — not a placeholder. */
      announcedBy: log.announcedBy
        ? (labels.get(log.announcedBy.toString()) ?? "")
        : "",
      id: log._id.toString(),
      mealType: log.mealType,
      message: log.message ?? "",
      notifiedCount: log.notifiedCount,
    })),
  };
}
