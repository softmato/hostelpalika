/**
 * Reference-code allocation — Block 2 item 2.5, target §5.2.
 *
 * `reference-code.ts` is exhaustively tested as pure arithmetic. The only thing
 * it cannot decide without I/O is *which* number comes next, and getting that
 * wrong is the failure that matters: two invoices sharing a code are
 * indistinguishable to every matcher downstream, so a payment carrying it could
 * settle either one.
 */
import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findOneAndUpdate: vi.fn(),
  hostelFindById: vi.fn(),
  hostelFindOneAndUpdate: vi.fn(),
}));

const lean = (value: unknown) => ({
  select: () => ({ lean: vi.fn().mockResolvedValue(value) }),
});

vi.mock("@hostel/db/models/Hostel", () => ({
  HostelModel: {
    findById: mocks.hostelFindById,
    findOneAndUpdate: mocks.hostelFindOneAndUpdate,
  },
}));

vi.mock("@hostel/db/models/ReceiptCounter", () => ({
  ReceiptCounterModel: { findOneAndUpdate: mocks.findOneAndUpdate },
}));

import { parseReferenceCode } from "@/modules/finance/reference-code";
import { allocateReferenceCode } from "@/modules/finance/reference-sequence.service";

const hostelId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0a1");

function counter(sequence: number) {
  return { lean: vi.fn().mockResolvedValue({ sequence }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findOneAndUpdate.mockReturnValue(counter(1));
});

describe("allocateReferenceCode", () => {
  it("allocates atomically, so concurrent callers cannot share a number", async () => {
    await allocateReferenceCode(hostelId, "RUP");

    const [filter, update, options] = mocks.findOneAndUpdate.mock.calls[0]!;

    expect(filter).toEqual({ hostelId, kind: "REFERENCE", period: "LIFETIME" });
    expect(update).toEqual({ $inc: { sequence: 1 } });
    expect(options).toMatchObject({ new: true, upsert: true });
  });

  it("shares no row with the receipt sequence", async () => {
    // Same collection, different `kind`. Sharing a row would make every receipt
    // consume a reference code and vice versa.
    await allocateReferenceCode(hostelId, "RUP");

    expect(mocks.findOneAndUpdate.mock.calls[0]![0]).toMatchObject({
      kind: "REFERENCE",
    });
  });

  it("produces a code that validates against its own check character", async () => {
    mocks.findOneAndUpdate.mockReturnValue(counter(4821));

    const code = await allocateReferenceCode(hostelId, "RUP");

    expect(parseReferenceCode(code)).toEqual({ prefix: "RUP", sequence: 4821 });
  });

  it("gives a hostel with no prefix one on its first invoice", async () => {
    // Hostel creation never set one, so this used to throw and intake raised
    // no invoice at all for every newer hostel.
    mocks.hostelFindById.mockReturnValue(lean({ name: "Test Hostel 1" }));
    mocks.hostelFindOneAndUpdate
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("dup"), { code: 11000 });
      })
      .mockReturnValueOnce(lean({ referencePrefix: "TEA" }));

    const code = await allocateReferenceCode(hostelId, null);

    expect(parseReferenceCode(code)?.prefix).toBe("TEA");
    expect(mocks.hostelFindOneAndUpdate.mock.calls.map((call) => call[1].$set.referencePrefix))
      .toEqual(["TES", "TEA"]);
  });

  it("errors rather than wrapping when the sequence is exhausted", async () => {
    // Wrapping silently would reissue a live code.
    mocks.findOneAndUpdate.mockReturnValue(counter(31 ** 4));

    await expect(allocateReferenceCode(hostelId, "RUP")).rejects.toThrow(/exhausted/);
  });
});
