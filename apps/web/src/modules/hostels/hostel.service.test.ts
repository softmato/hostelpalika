import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Role } from "@/lib/roles";

const serviceMocks = vi.hoisted(() => ({
  auditCreate: vi.fn(),
  bedCountDocuments: vi.fn(),
  bedFind: vi.fn(),
  bedFindOne: vi.fn(),
  bedFindOneAndUpdate: vi.fn(),
  connectToDatabase: vi.fn(),
  foodMenuFind: vi.fn(),
  foodMenuFindOne: vi.fn(),
  hostelCreate: vi.fn(),
  hostelExists: vi.fn(),
  hostelFind: vi.fn(),
  hostelFindOne: vi.fn(),
  hostelFindOneAndUpdate: vi.fn(),
  hostelUpdateOne: vi.fn(),
  inquiryCreate: vi.fn(),
  inquiryFind: vi.fn(),
  inquiryFindOne: vi.fn(),
  inquiryFindOneAndUpdate: vi.fn(),
  inquiryNoteCreate: vi.fn(),
  ratingAggregate: vi.fn(),
  roomCountDocuments: vi.fn(),
  roomFind: vi.fn(),
  roomFindOne: vi.fn(),
  roomFindOneAndUpdate: vi.fn(),
  roomUpdateOne: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  connectToDatabase: serviceMocks.connectToDatabase,
}));

vi.mock("@hostel/db/models/AuditLog", () => ({
  AuditLogModel: {
    create: serviceMocks.auditCreate,
  },
}));

vi.mock("@hostel/db/models/FoodRoutine", () => ({
  FoodRoutineModel: { findOne: serviceMocks.foodMenuFindOne },
}));

vi.mock("@hostel/db/models/Hostel", () => ({
  HostelModel: {
    countDocuments: vi.fn().mockResolvedValue(0),
    create: serviceMocks.hostelCreate,
    exists: serviceMocks.hostelExists,
    find: serviceMocks.hostelFind,
    findOne: serviceMocks.hostelFindOne,
    findOneAndUpdate: serviceMocks.hostelFindOneAndUpdate,
    updateOne: serviceMocks.hostelUpdateOne,
  },
}));

vi.mock("@hostel/db/models/HostelApplication", () => ({
  HostelApplicationModel: {
    create: vi.fn(),
    findById: vi.fn(),
    findOne: vi.fn(),
    updateMany: vi.fn(),
  },
}));

vi.mock("@hostel/db/models/HostelDocument", () => ({
  HostelDocumentModel: {
    insertMany: vi.fn(),
    updateMany: vi.fn(),
  },
}));

vi.mock("@hostel/db/models/HostelVerification", () => ({
  HostelVerificationModel: {
    create: vi.fn(),
    findOneAndUpdate: vi.fn(),
  },
}));

vi.mock("@hostel/db/models/Inquiry", () => ({
  InquiryModel: {
    countDocuments: vi.fn().mockResolvedValue(0),
    create: serviceMocks.inquiryCreate,
    find: serviceMocks.inquiryFind,
    findOne: serviceMocks.inquiryFindOne,
    findOneAndUpdate: serviceMocks.inquiryFindOneAndUpdate,
  },
}));

vi.mock("@hostel/db/models/InquiryNote", () => ({
  InquiryNoteModel: {
    create: serviceMocks.inquiryNoteCreate,
  },
}));

vi.mock("@hostel/db/models/RatingReview", () => ({
  RatingReviewModel: {
    aggregate: serviceMocks.ratingAggregate,
  },
}));

import {
  createPublicHostelInquiry,
  getPublicHostelBySlug,
  listPublicHostels,
} from "@/modules/hostels/hostel.service";
import { listHostelAdminInquiries } from "@/modules/hostels/hostel-inquiry.service";

const hostelId = "64f0f0f0f0f0f0f0f0f0f0f4";
const ownerId = "64f0f0f0f0f0f0f0f0f0f0f6";

const staffPrincipal = {
  hostelIds: [hostelId],
  role: Role.HOSTEL_ADMIN,
  userId: "64f0f0f0f0f0f0f0f0f0f0f8",
};

function leanResult<T>(value: T) {
  return {
    lean: vi.fn().mockResolvedValue(value),
  };
}

function queryResult<T>(value: T) {
  return {
    lean: vi.fn().mockResolvedValue(value),
    limit: vi.fn().mockReturnThis(),
    skip: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    sort: vi.fn().mockReturnThis(),
  };
}

function hostelRecord(overrides: Record<string, unknown> = {}) {
  return {
    _id: new Types.ObjectId(hostelId),
    contact: {
      email: "admin@sunrise.test",
      phone: "9800000000",
    },
    hostelType: "GIRLS",
    location: {
      area: "Baneshwor",
      city: "Kathmandu",
    },
    name: "Sunrise Hostel",
    ownerId: new Types.ObjectId(ownerId),
    slug: "sunrise-hostel",
    status: "PUBLISHED",
    verificationStatus: "VERIFIED",
    ...overrides,
  };
}

describe("hostel service phase 2 behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceMocks.hostelFind.mockReturnValue(queryResult([]));
    // Public hostel detail also reads the published routine; default to none.
    serviceMocks.foodMenuFind.mockReturnValue(queryResult([]));
    serviceMocks.foodMenuFindOne.mockReturnValue(queryResult(null));
    // Every public surface now carries a rating summary; default to unreviewed.
    serviceMocks.ratingAggregate.mockResolvedValue([]);
  });

  it("filters public listings to approved published hostels and requested filters", async () => {
    serviceMocks.hostelFind.mockReturnValueOnce(queryResult([hostelRecord()]));

    await expect(
      listPublicHostels({
        area: "Baneshwor",
        facility: "wifi",
        food: "veg",
        maxPrice: 15000,
        minPrice: 8000,
        q: "sunrise",
        roomType: "single",
        type: "GIRLS",
      }),
    ).resolves.toMatchObject({
      hostels: [{ name: "Sunrise Hostel", slug: "sunrise-hostel" }],
    });

    expect(serviceMocks.hostelFind).toHaveBeenCalledWith(
      expect.objectContaining({
        "food.hasVeg": true,
        "location.area": expect.any(RegExp),
        "pricing.monthlyRentMax": { $gte: 8000 },
        "pricing.monthlyRentMin": { $lte: 15000 },
        facilities: "wifi",
        hostelType: "GIRLS",
        isDeleted: false,
        roomTypes: "single",
        status: "PUBLISHED",
        verificationStatus: "VERIFIED",
      }),
    );
  });

  it("lists the first hostel and its branch independently with their own photos", async () => {
    const branchId = new Types.ObjectId();
    serviceMocks.hostelFind.mockReturnValueOnce(queryResult([
      hostelRecord({ photos: [{ url: "/first.jpg", kind: "EXTERIOR" }] }),
      hostelRecord({ _id: branchId, parentHostelId: new Types.ObjectId(hostelId), slug: "sunrise-patan", name: "Sunrise Patan", photos: [{ url: "/patan.jpg", kind: "EXTERIOR" }] }),
    ]));
    const result = await listPublicHostels({});
    expect(result.hostels.find((hostel) => hostel.id === hostelId)?.photos[0].url).toBe("/first.jpg");
    expect(result.hostels.find((hostel) => hostel.id === String(branchId))?.photos[0].url).toBe("/patan.jpg");
    expect(serviceMocks.hostelFind.mock.calls[0][0]).not.toHaveProperty("parentHostelId");
  });

  it("serializes public hostel detail without owner or contact fields", async () => {
    serviceMocks.hostelFindOne.mockReturnValueOnce(leanResult(hostelRecord()));

    const result = await getPublicHostelBySlug("sunrise-hostel");

    expect(result.hostel).toMatchObject({
      id: hostelId,
      name: "Sunrise Hostel",
      slug: "sunrise-hostel",
    });
    expect(result.hostel).not.toHaveProperty("ownerId");
    // The public payload carries the phone so a visitor can call, and nothing
    // else from `contact` — the email stays behind the inquiry form.
    expect(result.hostel.contact).toEqual({ phone: "9800000000" });
    expect(serviceMocks.hostelFindOne).toHaveBeenCalledWith({
      isDeleted: false,
      slug: "sunrise-hostel",
      status: "PUBLISHED",
      verificationStatus: "VERIFIED",
    });
  });

  /**
   * The discovery mockups put a star rating on every list card and on the
   * detail hero. Before this, `RatingReviewModel` was aggregated *only* in
   * `comparePublicHostels`, so both of those had nothing behind them.
   */
  describe("public rating summaries", () => {
    function ratingRow(overrides: Record<string, unknown> = {}) {
      return {
        _id: new Types.ObjectId(hostelId),
        averageRating: 4.5,
        cleanlinessRating: 4,
        foodRating: 3.5,
        safetyRating: 5,
        total: 12,
        ...overrides,
      };
    }

    it("attaches a rating summary to every listing card", async () => {
      serviceMocks.hostelFind.mockReturnValueOnce(queryResult([hostelRecord()]));
      serviceMocks.ratingAggregate.mockResolvedValueOnce([ratingRow()]);

      const result = await listPublicHostels({});

      expect(result.hostels[0].ratingSummary).toEqual({
        averageRating: 4.5,
        cleanlinessRating: 4,
        foodRating: 3.5,
        safetyRating: 5,
        total: 12,
      });
    });

    it("counts only visible reviews", async () => {
      // A review a moderator hid is hidden because it should not be read. An
      // average that still includes it publishes its verdict as a number.
      serviceMocks.hostelFind.mockReturnValueOnce(queryResult([hostelRecord()]));

      await listPublicHostels({});

      expect(serviceMocks.ratingAggregate).toHaveBeenCalledWith([
        expect.objectContaining({
          $match: expect.objectContaining({ status: "VISIBLE" }),
        }),
        expect.anything(),
      ]);
    });

    it("reports an unreviewed hostel as total 0, not as zero stars", async () => {
      serviceMocks.hostelFind.mockReturnValueOnce(queryResult([hostelRecord()]));
      serviceMocks.ratingAggregate.mockResolvedValueOnce([]);

      const result = await listPublicHostels({});

      // `total` is the field that says whether there is a rating at all —
      // branching on `averageRating` renders a brand-new hostel as one star.
      expect(result.hostels[0].ratingSummary.total).toBe(0);
      expect(result.hostels[0].ratingSummary.averageRating).toBe(0);
    });

    it("attaches a rating summary to the detail payload", async () => {
      serviceMocks.hostelFindOne.mockReturnValueOnce(leanResult(hostelRecord()));
      serviceMocks.ratingAggregate.mockResolvedValueOnce([ratingRow()]);

      const result = await getPublicHostelBySlug("sunrise-hostel");

      expect(result.hostel.ratingSummary).toMatchObject({
        averageRating: 4.5,
        total: 12,
      });
    });

    it("survives a review that left the sub-scores blank", async () => {
      // `$avg` returns null when every input is null, and null in a number
      // field is how a card renders "NaN ★".
      serviceMocks.hostelFind.mockReturnValueOnce(queryResult([hostelRecord()]));
      serviceMocks.ratingAggregate.mockResolvedValueOnce([
        ratingRow({ cleanlinessRating: null, foodRating: null, safetyRating: null }),
      ]);

      const result = await listPublicHostels({});

      expect(result.hostels[0].ratingSummary).toMatchObject({
        averageRating: 4.5,
        cleanlinessRating: 0,
        foodRating: 0,
        total: 12,
      });
    });

    it("does not query at all when the listing is empty", async () => {
      // 60 hostels per page, so this is the one place a per-card lookup would
      // have become 60 sequential queries.
      serviceMocks.hostelFind.mockReturnValueOnce(queryResult([]));

      await listPublicHostels({});

      expect(serviceMocks.ratingAggregate).not.toHaveBeenCalled();
    });
  });

  it("creates public inquiries against visible hostels only", async () => {
    const inquiryId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0f9");

    serviceMocks.hostelFindOne.mockReturnValueOnce(leanResult(hostelRecord()));
    serviceMocks.inquiryCreate.mockResolvedValueOnce({
      _id: inquiryId,
      hostelId: new Types.ObjectId(hostelId),
      name: "Asha Rai",
      phone: "9800000000",
      source: "PUBLIC_WEBSITE",
      status: "NEW",
    });

    const result = await createPublicHostelInquiry(hostelId, {
      message: "Can I visit tomorrow?",
      name: "Asha Rai",
      phone: "9800000000",
    });

    expect(result.inquiry).toMatchObject({
      hostelId,
      id: inquiryId.toString(),
      status: "NEW",
    });
    expect(serviceMocks.hostelFindOne).toHaveBeenCalledWith({
      _id: new Types.ObjectId(hostelId),
      isDeleted: false,
      status: "PUBLISHED",
      verificationStatus: "VERIFIED",
    });
    expect(serviceMocks.inquiryCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        hostelId: new Types.ObjectId(hostelId),
        name: "Asha Rai",
        source: "PUBLIC_WEBSITE",
        status: "NEW",
      }),
    );
  });

  it("limits hostel-admin inquiry lists to the principal hostel ids", async () => {
    serviceMocks.inquiryFind.mockReturnValueOnce(queryResult([]));

    await listHostelAdminInquiries({}, staffPrincipal);

    expect(serviceMocks.inquiryFind).toHaveBeenCalledWith({
      hostelId: {
        $in: [new Types.ObjectId(hostelId)],
      },
      isDeleted: false,
    });
  });
});
