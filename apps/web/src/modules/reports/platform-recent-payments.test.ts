import { Types } from "mongoose";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ hostelFind: vi.fn(), eventFind: vi.fn(), count: vi.fn() }));
vi.mock("@/lib/db", () => ({ connectToDatabase: vi.fn() }));
vi.mock("@hostel/db/models/Hostel", () => ({ HostelModel: { find: mocks.hostelFind } }));
vi.mock("@hostel/db/models/PaymentEvent", () => ({ PaymentEventModel: { find: mocks.eventFind, countDocuments: mocks.count } }));

import { getRecentPlatformPayments } from "./report.service";

describe("platform dashboard receipts", () => {
  it("pages settled credits from live hostels and reports the receipt amount and date", async () => {
    const hostelId = new Types.ObjectId();
    const eventId = new Types.ObjectId();
    const paidAt = new Date("2026-10-03T12:00:00Z");
    mocks.hostelFind.mockReturnValue({ select: () => ({ lean: async () => [{ _id: hostelId, name: "Test Hostel" }] }) });
    const chain = { sort: vi.fn().mockReturnThis(), skip: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), lean: vi.fn().mockResolvedValue([{ _id: eventId, hostelId, amount: 500, provider: "CASH", settledAt: paidAt }]) };
    mocks.eventFind.mockReturnValue(chain);
    mocks.count.mockResolvedValue(12);
    const result = await getRecentPlatformPayments({ page: 2, pageSize: 5 });
    const filter = { hostelId: { $in: [hostelId] }, status: "SETTLED", direction: "CREDIT" };
    expect(mocks.eventFind).toHaveBeenCalledWith(filter);
    expect(mocks.count).toHaveBeenCalledWith(filter);
    expect(chain.sort).toHaveBeenCalledWith({ settledAt: -1, _id: -1 });
    expect(chain.skip).toHaveBeenCalledWith(5);
    expect(chain.limit).toHaveBeenCalledWith(5);
    expect(result.pagination).toMatchObject({ total: 12, page: 2, totalPages: 3 });
    expect(result.recent).toEqual([{ id: String(eventId), hostelName: "Test Hostel", paidAmount: 500, provider: "CASH", status: "SETTLED", paidAt: paidAt.toISOString() }]);
  });
});
