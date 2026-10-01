/**
 * The join link's own rules (docs/EXISTING_RESIDENTS.md, "Join link"): a new
 * request uses one place on the link, an edit or a re-send after "Send back"
 * never does, staff hear about new and fixed requests only, and the person's
 * name and phone are their ID card's.
 */
import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appCreate: vi.fn(),
  appFindOne: vi.fn(),
  appUpdateOne: vi.fn(),
  contextFor: vi.fn(),
  hostelFindOne: vi.fn(),
  identity: vi.fn(),
  linkFindOne: vi.fn(),
  linkFindOneAndUpdate: vi.fn(),
  linkUpdateOne: vi.fn(),
  liveResidency: vi.fn(),
  notify: vi.fn(),
  roomTypesFor: vi.fn(),
  staff: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ connectToDatabase: vi.fn() }));
vi.mock("@/lib/after-response", () => ({ afterResponse: (work: () => unknown) => void work() }));
vi.mock("@/lib/hostel-day", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hostel-day")>()),
  // Aswin 2083 is "this month".
  hostelPeriodOf: () => "2083-06",
}));
vi.mock("@/modules/residents/existing-residents.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/residents/existing-residents.service")>()),
  contextFor: mocks.contextFor,
  roomTypesFor: mocks.roomTypesFor,
}));
vi.mock("@/modules/users/resident-identity.service", () => ({ getResidentIdentity: mocks.identity }));
vi.mock("@/modules/residents/live-residency", () => ({ findLiveResidency: mocks.liveResidency }));
vi.mock("@/modules/notifications/notification.service", () => ({
  createInAppNotification: mocks.notify,
}));
vi.mock("@/modules/residents/resident-notify", () => ({
  resolveHostelStaffUserIds: mocks.staff,
  sendNotificationEmail: vi.fn(),
}));
vi.mock("@hostel/db/models/Hostel", () => ({
  HostelModel: { findById: vi.fn(), findOne: mocks.hostelFindOne },
}));
vi.mock("@hostel/db/models/ResidentJoinLink", () => ({
  ResidentJoinLinkModel: {
    findOne: mocks.linkFindOne,
    findOneAndUpdate: mocks.linkFindOneAndUpdate,
    updateOne: mocks.linkUpdateOne,
  },
}));
vi.mock("@hostel/db/models/ResidentApplication", () => ({
  ResidentApplicationModel: {
    create: mocks.appCreate,
    findOne: mocks.appFindOne,
    updateOne: mocks.appUpdateOne,
  },
}));

import { sendJoinRequest } from "@/modules/residents/resident-join.service";

const hostelId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0a1");
const userId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0c1").toString();
const link = { _id: new Types.ObjectId(), cap: 10, enabled: true, hostelId, token: "tok", used: 3 };
const input = {
  depositPaid: 5000,
  joinedDate: null,
  note: "",
  paidTill: "2083-05",
  partPaid: 2000,
  roomType: "double",
};

function lean<T>(value: T) {
  const query = { lean: vi.fn().mockResolvedValue(value), select: vi.fn() };

  query.select.mockReturnValue(query);

  return query;
}

function existing(status: string) {
  return {
    _id: new Types.ObjectId(),
    cardId: "HH-4K7M-9XQ2",
    decidedAt: status === "PENDING" ? null : new Date(),
    depositPaid: 0,
    email: "ram@example.com",
    fullName: "Ram Thapa",
    paidTill: "2083-06",
    partPaid: 0,
    phone: "9841234567",
    roomType: "Double",
    sends: 1,
    sentAt: new Date(),
    status,
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  mocks.linkFindOne.mockReturnValue(lean(link));
  mocks.linkFindOneAndUpdate.mockResolvedValue(link);
  mocks.hostelFindOne.mockReturnValue(
    lean({ location: { city: "Kathmandu" }, name: "Education Light", roomConfigurations: [] }),
  );
  mocks.roomTypesFor.mockResolvedValue([{ monthlyRent: 12000, roomType: "Double", vacantBeds: 4 }]);
  mocks.contextFor.mockImplementation(async (_hostel, _rows, roomTypes) => ({
    currentPeriod: "2083-06",
    livingElsewhere: new Map(),
    roomTypes,
    takenEmails: new Map(),
    takenPhones: new Map(),
  }));
  mocks.identity.mockResolvedValue({
    identity: {
      accountEmail: "ram@example.com",
      accountName: "Ram",
      hasPhoto: true,
      hasProfile: true,
      photoUpdatedAt: null,
      residentId: "HH-4K7M-9XQ2",
      sharingEnabled: true,
    },
    profile: { fullName: "Ram  Thapa", primaryEmail: "ram@example.com", primaryPhone: "9841234567" },
  });
  mocks.liveResidency.mockResolvedValue(null);
  mocks.appFindOne.mockReturnValue(lean(null));
  mocks.appCreate.mockResolvedValue({});
  mocks.staff.mockResolvedValue(["staff-1"]);
});

describe("sending a join request", () => {
  it("uses one place on the link, takes name and phone from the ID card, and tells staff", async () => {
    await sendJoinRequest("tok", input, userId);

    expect(mocks.linkFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: link._id, enabled: true, $expr: { $lt: ["$used", "$cap"] } },
      { $inc: { used: 1 } },
    );
    expect(mocks.appCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        cardId: "HH-4K7M-9XQ2",
        fullName: "Ram Thapa",
        partPaid: 2000,
        phone: "9841234567",
        roomType: "Double",
      }),
    );
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Ram Thapa asked to be added as a resident", userId: "staff-1" }),
    );
  });

  it("edits a waiting request in place — no place used, nobody told", async () => {
    mocks.appFindOne.mockReturnValue(lean(existing("PENDING")));

    await sendJoinRequest("tok", input, userId);

    expect(mocks.linkFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.appCreate).not.toHaveBeenCalled();
    expect(mocks.appUpdateOne.mock.calls[0]![1]).not.toHaveProperty("$inc");
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("counts a fix after Send back as the same request, and tells staff it was fixed", async () => {
    mocks.appFindOne.mockReturnValue(lean(existing("REJECTED")));

    await sendJoinRequest("tok", input, userId);

    expect(mocks.linkFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.appUpdateOne.mock.calls[0]![1]).toMatchObject({
      $inc: { sends: 1 },
      $set: { rejectReason: "", status: "PENDING" },
    });
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Ram Thapa fixed their request to join" }),
    );
  });

  it("refuses a new request once the link is full", async () => {
    mocks.linkFindOneAndUpdate.mockResolvedValue(null);

    await expect(sendJoinRequest("tok", input, userId)).rejects.toMatchObject({
      errorCode: "JOIN_LINK_FULL",
    });
    expect(mocks.appCreate).not.toHaveBeenCalled();
  });

  it("needs an ID card the hostel can see", async () => {
    mocks.identity.mockResolvedValue({
      identity: { accountEmail: "ram@example.com", hasProfile: true, residentId: "HH-4K7M-9XQ2", sharingEnabled: false },
      profile: { fullName: "Ram Thapa", primaryPhone: "9841234567" },
    });

    await expect(sendJoinRequest("tok", input, userId)).rejects.toMatchObject({
      errorCode: "JOIN_CARD_PRIVATE",
    });
  });

  it("refuses part paid that covers the whole first month", async () => {
    await expect(
      sendJoinRequest("tok", { ...input, partPaid: 12000 }, userId),
    ).rejects.toMatchObject({ details: { field: "partPaid" }, errorCode: "JOIN_REQUEST_INVALID" });
  });
});
