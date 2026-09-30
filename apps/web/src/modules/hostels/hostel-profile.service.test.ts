import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Role } from "@/lib/roles";

const profileMocks = vi.hoisted(() => ({
  auditCreate: vi.fn(),
  connectToDatabase: vi.fn(),
  geocodeAndCacheHostel: vi.fn(),
  hostelFindOne: vi.fn(),
  hostelFindOneAndUpdate: vi.fn(),
  getOpenFeeSchedule: vi.fn(),
  sendNotificationEmail: vi.fn(),
  userFind: vi.fn(),
}));

/*
 * The rate card is the source of a price, so the profile save asks whether one
 * exists before it lets a rent through. No card here: these cases are about
 * renames and photos, and a hostel with no rate card is the state every hostel
 * starts in.
 */
vi.mock("@/modules/finance/fee-schedule.service", () => ({
  getOpenFeeSchedule: profileMocks.getOpenFeeSchedule,
}));

vi.mock("@/lib/db", () => ({
  connectToDatabase: profileMocks.connectToDatabase,
}));

vi.mock("@/modules/hostels/hostel-geo.service", () => ({
  geocodeAndCacheHostel: profileMocks.geocodeAndCacheHostel,
}));

vi.mock("@/modules/residents/resident-notify", () => ({
  sendNotificationEmail: profileMocks.sendNotificationEmail,
}));

vi.mock("@hostel/db/models/AuditLog", () => ({
  AuditLogModel: { create: profileMocks.auditCreate },
}));

vi.mock("@hostel/db/models/Hostel", () => ({
  HostelModel: {
    findOne: profileMocks.hostelFindOne,
    findOneAndUpdate: profileMocks.hostelFindOneAndUpdate,
  },
}));

vi.mock("@hostel/db/models/User", () => ({
  UserModel: { find: profileMocks.userFind },
}));

import {
  addHostelAdminProfilePhoto,
  requestHostelProfileChange,
  updateHostelAdminProfile,
} from "@/modules/hostels/hostel-profile.service";

const hostelId = "64f0f0f0f0f0f0f0f0f0f0f4";

const staffPrincipal = {
  hostelIds: [hostelId],
  role: Role.HOSTEL_ADMIN,
  userId: "64f0f0f0f0f0f0f0f0f0f0f8",
};

function leanResult<T>(value: T) {
  return { lean: vi.fn().mockResolvedValue(value) };
}

function hostelRecord(overrides: Record<string, unknown> = {}) {
  return {
    _id: new Types.ObjectId(hostelId),
    location: { area: "Baneshwor", city: "Kathmandu" },
    name: "Sunrise Hostel",
    nameChangeCount: 0,
    ownerId: new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0f6"),
    photos: [],
    slug: "sunrise-hostel",
    status: "APPROVED",
    verificationStatus: "VERIFIED",
    ...overrides,
  };
}

describe("hostel profile service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    profileMocks.connectToDatabase.mockResolvedValue(undefined);
    profileMocks.auditCreate.mockResolvedValue(undefined);
    profileMocks.sendNotificationEmail.mockResolvedValue(undefined);
    profileMocks.geocodeAndCacheHostel.mockResolvedValue(null);
    profileMocks.getOpenFeeSchedule.mockResolvedValue(null);
  });

  it("counts a rename against the post-approval allowance", async () => {
    profileMocks.hostelFindOne.mockReturnValueOnce(leanResult(hostelRecord()));
    profileMocks.hostelFindOneAndUpdate.mockReturnValueOnce(
      leanResult(hostelRecord({ name: "Sunrise Boys Hostel", nameChangeCount: 1 })),
    );

    await updateHostelAdminProfile({ name: "Sunrise Boys Hostel" }, staffPrincipal);

    expect(profileMocks.hostelFindOneAndUpdate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ $inc: { nameChangeCount: 1 } }),
      expect.anything(),
    );
  });

  it("rejects a rename once the allowance is used up", async () => {
    profileMocks.hostelFindOne.mockReturnValueOnce(
      leanResult(hostelRecord({ nameChangeCount: 2 })),
    );

    await expect(
      updateHostelAdminProfile({ name: "Third Name" }, staffPrincipal),
    ).rejects.toMatchObject({ errorCode: "NAME_CHANGE_LIMIT_REACHED", status: 403 });
    expect(profileMocks.hostelFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("still allows renames before approval and does not count them", async () => {
    profileMocks.hostelFindOne.mockReturnValueOnce(
      leanResult(hostelRecord({ nameChangeCount: 2, status: "DRAFT" })),
    );
    profileMocks.hostelFindOneAndUpdate.mockReturnValueOnce(
      leanResult(hostelRecord({ name: "Draft Rename", status: "DRAFT" })),
    );

    await updateHostelAdminProfile({ name: "Draft Rename" }, staffPrincipal);

    const [, update] = profileMocks.hostelFindOneAndUpdate.mock.calls[0];
    expect(update).not.toHaveProperty("$inc");
  });

  it("writes a picked pin field by field, with its MANUAL source", async () => {
    profileMocks.hostelFindOne.mockReturnValueOnce(leanResult(hostelRecord()));
    profileMocks.hostelFindOneAndUpdate.mockReturnValueOnce(leanResult(hostelRecord()));

    await updateHostelAdminProfile(
      { location: { area: "Baluwatar", lat: 27.72, lng: 85.33, locationSource: "MANUAL" } },
      staffPrincipal,
    );

    const [, update] = profileMocks.hostelFindOneAndUpdate.mock.calls[0];
    expect(update.$set).not.toHaveProperty("location");
    expect(update.$set).toMatchObject({
      "location.area": "Baluwatar",
      "location.lat": 27.72,
      "location.lng": 85.33,
      "location.locationSource": "MANUAL",
    });
    expect(update).not.toHaveProperty("$unset");
  });

  it("leaves unsent location fields alone and clears an emptied one", async () => {
    profileMocks.hostelFindOne.mockReturnValueOnce(leanResult(hostelRecord()));
    profileMocks.hostelFindOneAndUpdate.mockReturnValueOnce(leanResult(hostelRecord()));

    await updateHostelAdminProfile(
      { location: { address: "", area: "Baneshwor", city: "Kathmandu" } },
      staffPrincipal,
    );

    const [, update] = profileMocks.hostelFindOneAndUpdate.mock.calls[0];
    // Not sent, so a stored MANUAL flag, landmark and map link survive the save.
    expect(update.$set).not.toHaveProperty("location");
    expect(update.$set).not.toHaveProperty(["location.locationSource"]);
    expect(update.$set).not.toHaveProperty(["location.landmark"]);
    expect(update.$unset).toEqual({ "location.address": "" });
  });

  it("caps exterior photos at three", async () => {
    profileMocks.hostelFindOne.mockReturnValueOnce(
      leanResult(
        hostelRecord({
          photos: [
            { kind: "EXTERIOR", url: "a" },
            { kind: "EXTERIOR", url: "b" },
            { kind: "EXTERIOR", url: "c" },
          ],
        }),
      ),
    );

    await expect(
      addHostelAdminProfilePhoto(
        { kind: "EXTERIOR", url: "https://cdn.test/d.jpg" },
        staffPrincipal,
      ),
    ).rejects.toMatchObject({ errorCode: "PHOTO_LIMIT_REACHED", status: 422 });
  });

  it("still accepts interior photos when the exterior slots are full", async () => {
    profileMocks.hostelFindOne.mockReturnValueOnce(
      leanResult(
        hostelRecord({
          photos: [
            { kind: "EXTERIOR", url: "a" },
            { kind: "EXTERIOR", url: "b" },
            { kind: "EXTERIOR", url: "c" },
          ],
        }),
      ),
    );
    profileMocks.hostelFindOneAndUpdate.mockReturnValueOnce(leanResult(hostelRecord()));

    await expect(
      addHostelAdminProfilePhoto(
        { kind: "INTERIOR", url: "https://cdn.test/inside.jpg" },
        staffPrincipal,
      ),
    ).resolves.toBeTruthy();
  });

  it("emails every superadmin when a locked change is requested", async () => {
    profileMocks.hostelFindOne.mockReturnValueOnce(leanResult(hostelRecord()));
    profileMocks.userFind.mockReturnValueOnce(
      leanResult([{ email: "boss@hostelpalika.test" }, { email: "ops@hostelpalika.test" }]),
    );

    const result = await requestHostelProfileChange(
      { changeType: "OWNER_EMAIL", requestedValue: "new-owner@example.com" },
      staffPrincipal,
    );

    expect(result.notifiedAdmins).toBe(2);
    expect(profileMocks.sendNotificationEmail).toHaveBeenCalledTimes(2);
    expect(profileMocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ action: "HOSTEL_CHANGE_REQUESTED" }),
    );
  });
});
