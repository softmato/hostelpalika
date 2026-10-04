import { Types } from "mongoose";
import { expect, it, vi } from "vitest";
import { Role } from "@/lib/roles";
import type { FakeModel } from "../../../test/fake-mongo";

vi.mock("@/modules/finance/reference-sequence.service", () => ({
  allocateReferenceCode: vi.fn(async () => "ABC-001-X"),
}));
vi.mock("@hostel/db/models/Invoice", async (original) => ({
  ...(await original<object>()),
  InvoiceModel: (await import("../../../test/fake-mongo")).fakeModel(),
}));
vi.mock("@hostel/db/models/Hostel", async (original) => ({
  ...(await original<object>()),
  HostelModel: (await import("../../../test/fake-mongo")).fakeModel(),
}));

const { InvoiceModel } = await import("@hostel/db/models/Invoice");
const { HostelModel } = await import("@hostel/db/models/Hostel");
const { quoteIntake, raiseAdmissionInvoice } = await import("./resident-intake.service");

it("raises a form-fee-only joining invoice once, with an explicit line", async () => {
  const hostelId = new Types.ObjectId();
  const residentId = new Types.ObjectId();
  const invoices = InvoiceModel as unknown as FakeModel;
  invoices.reset([]);
  (HostelModel as unknown as FakeModel).reset([
    { _id: hostelId, referencePrefix: "ABC" },
  ]);
  const quote = quoteIntake({
    hostel: { pricing: { formFee: 300 } },
    roomType: "Single Room",
    schedule: null,
    referralCodeActive: false,
  });
  const input = {
    hostelId,
    residentId,
    quote,
    dueDate: new Date(),
    principal: {
      hostelIds: [String(hostelId)],
      userId: String(new Types.ObjectId()),
      role: Role.HOSTEL_ADMIN,
    },
  };
  expect(await raiseAdmissionInvoice(input)).toMatchObject({ raised: true, amount: 300 });
  expect(invoices.docs[0]).toMatchObject({
    totalAmount: 300,
    lines: [{ description: "Form fee", amount: 300, basis: "MANUAL" }],
  });
  await raiseAdmissionInvoice(input);
  expect(invoices.docs).toHaveLength(1);
});
