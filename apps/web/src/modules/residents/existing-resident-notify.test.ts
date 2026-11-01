import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fromBs } from "@/lib/hostel-day";

const mocks = vi.hoisted(() => ({
  contact: vi.fn(),
  inApp: vi.fn(),
  invoiceFind: vi.fn(),
  issue: vi.fn(),
  residentFindById: vi.fn(),
  send: vi.fn(),
  staff: vi.fn(),
  userFindOne: vi.fn(),
}));

vi.mock("@/modules/notifications/notification.service", () => ({
  createInAppNotification: mocks.inApp,
}));
vi.mock("@/modules/residents/activation.service", () => ({
  activationUrl: (code: string) => `https://app.test/resident-activation?code=${code}`,
  issueActivationCode: mocks.issue,
}));
vi.mock("@/modules/residents/resident-notify", () => ({
  appUrl: (path: string) => `https://app.test${path}`,
  getHostelName: async () => "Education Light",
  resolveHostelStaffUserIds: mocks.staff,
  resolveResidentContact: mocks.contact,
  sendNotificationEmail: mocks.send,
}));
vi.mock("@hostel/db/models/Invoice", () => ({ InvoiceModel: { find: mocks.invoiceFind } }));
vi.mock("@hostel/db/models/Resident", () => ({ ResidentModel: { findById: mocks.residentFindById } }));
vi.mock("@hostel/db/models/User", () => ({ UserModel: { findOne: mocks.userFindOne } }));

import { notifyExistingResidentsAdded } from "@/modules/residents/existing-resident-notify";

const hostelId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0a1");
const residentId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0c1");
const principal = { userId: "64f0f0f0f0f0f0f0f0f0f0b1" } as never;

function chain<T>(value: T) {
  const query = { lean: vi.fn().mockResolvedValue(value), select: vi.fn(), sort: vi.fn() };

  query.select.mockReturnValue(query);
  query.sort.mockReturnValue(query);

  return query;
}

function resident(overrides: Record<string, unknown> = {}) {
  return {
    _id: residentId,
    depositAmount: 10000,
    email: "ram@example.com",
    firstName: "Ram",
    hostelId,
    lastName: "Thapa",
    paidTill: "2083-06",
    roomType: "Double",
    ...overrides,
  };
}

const aswinLastDay = fromBs({ day: 31, month: 6, year: 2083 });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.residentFindById.mockReturnValue(chain(resident()));
  mocks.invoiceFind.mockReturnValue(chain([]));
  mocks.contact.mockResolvedValue({ email: "ram@example.com", name: "Ram Thapa" });
  mocks.send.mockResolvedValue(true);
  mocks.staff.mockResolvedValue(["owner1"]);
  mocks.issue.mockResolvedValue({ code: "AB12CD34", expiresAt: aswinLastDay });
  mocks.userFindOne.mockReturnValue(chain(null));
});

function sentEmail() {
  return mocks.send.mock.calls[0]![0] as { html: string; subject: string; to: string };
}

describe("telling existing residents", () => {
  it("tells a resident who has paid when their next bill is, with a link to set up the app", async () => {
    const outcome = await notifyExistingResidentsAdded({
      added: [{ rent: 12000, residentId }],
      billsRaised: 0,
      hostelId,
      principal,
    });

    expect(outcome).toEqual({ emailed: 1, unreached: 0 });

    const email = sentEmail();

    expect(email.to).toBe("ram@example.com");
    expect(email.subject).toBe("Education Light is now on HostelPalika");
    expect(email.html).toContain("Nothing to pay now");
    expect(email.html).toMatch(/Paid till<\/td>[\s\S]*?>Aswin 2083</);
    expect(email.html).toContain("get receipts");
    expect(email.html).toMatch(/Next bill<\/td>[\s\S]*?>Kartik 2083</);
    expect(email.html).toContain("resident-activation?code=AB12CD34");
    // No account, so nothing to push to.
    expect(mocks.inApp).toHaveBeenCalledTimes(1);
    expect(mocks.inApp.mock.calls[0]![0]).toMatchObject({ userId: "owner1" });
  });

  it("lists each month due and the old dues with their codes, and one total", async () => {
    mocks.residentFindById.mockReturnValue(chain(resident({ paidTill: "2083-04" })));
    mocks.invoiceFind.mockReturnValue(
      chain([
        { _id: new Types.ObjectId(), dueDate: aswinLastDay, kind: "ADJUSTMENT", lines: [{ description: "Old dues (before HostelPalika)" }], referenceCode: "EDL-3", totalAmount: 2500 },
        { _id: new Types.ObjectId(), dueDate: aswinLastDay, kind: "MONTHLY_RENT", period: "2083-05", referenceCode: "EDL-1", totalAmount: 12000 },
        { _id: new Types.ObjectId(), dueDate: aswinLastDay, kind: "MONTHLY_RENT", period: "2083-06", referenceCode: "EDL-2", totalAmount: 12000 },
      ]),
    );

    await notifyExistingResidentsAdded({ added: [{ rent: 12000, residentId }], billsRaised: 3, hostelId, principal });

    const email = sentEmail();

    expect(email.subject).toBe("Education Light is now on HostelPalika — please pay Rs 26,500");
    expect(email.html).toContain("To pay by Aswin 31, 2083 BS");

    const order = ["Bhadra 2083 rent", "Aswin 2083 rent", "Old dues"].map((label) => email.html.indexOf(label));

    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(email.html).toContain(">EDL-1<");
    expect(email.html).toContain(">Rs 26,500<");
  });

  it("asks an existing account to confirm, without linking it or sending a setup link", async () => {
    const userId = new Types.ObjectId();

    mocks.userFindOne.mockReturnValue(chain({ _id: userId }));

    await notifyExistingResidentsAdded({ added: [{ rent: 12000, residentId }], billsRaised: 0, hostelId, principal });

    expect(mocks.issue).not.toHaveBeenCalled();
    expect(mocks.inApp).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "Education Light added you as a resident. Open to confirm it is you.",
        data: { type: "RESIDENCY_INVITE" },
        title: "Confirm your hostel",
        userId: userId.toString(),
      }),
    );
    expect(sentEmail().html).toContain("Open my account");
  });

  it("counts residents with no email so the hostel knows to tell them", async () => {
    mocks.contact.mockResolvedValue(null);

    const outcome = await notifyExistingResidentsAdded({
      added: [{ rent: 12000, residentId }],
      billsRaised: 0,
      hostelId,
      principal,
    });

    expect(outcome).toEqual({ emailed: 0, unreached: 1 });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.inApp).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "0 bills made · 0 emailed · 1 with no email — tell them yourself",
        title: "1 existing resident added",
      }),
    );
  });
});
