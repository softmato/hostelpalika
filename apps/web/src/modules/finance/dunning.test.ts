/**
 * Dunning — Block 5 item 5.2 of docs/FINANCE_IMPLEMENTATION_PLAN.md
 * (target §10.3).
 *
 * The plan names three cases and all three are here: a resident at position 900
 * in the open-invoice ordering **is** reminded, one missed cron day does not
 * permanently skip a resident, and the chase ladder stops. The first two are the
 * defects that made the old job quietly wrong — nobody notices an email that was
 * never sent — so they are asserted directly rather than inferred from the
 * scanned count.
 */
import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hostelId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0a1");
const runId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0b9");

const mocks = vi.hoisted(() => ({
  adminContacts: vi.fn(),
  balanceFind: vi.fn(),
  createNotification: vi.fn(),
  invoiceFind: vi.fn(),
  invoiceUpdateOne: vi.fn(),
  residentContact: vi.fn(),
  residentFind: vi.fn(),
  runCreate: vi.fn(),
  runUpdateOne: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ connectToDatabase: vi.fn() }));
vi.mock("@/modules/platform-config/operations-config", () => ({
  getOperationsConfig: vi
    .fn()
    .mockResolvedValue({ paymentReminderDaysBefore: 3, sendPaymentEmails: true }),
}));
vi.mock("@/modules/notifications/notification.service", () => ({
  createInAppNotification: mocks.createNotification,
}));
vi.mock("@/modules/residents/resident-notify", () => ({
  appUrl: (path: string) => `https://example.test${path}`,
  getHostelName: vi.fn().mockResolvedValue("Rupa Hostel"),
  resolveHostelAdminContacts: mocks.adminContacts,
  resolveResidentContact: mocks.residentContact,
  sendNotificationEmail: mocks.sendEmail,
  // One batch per page; forwarded so every assertion reads one email at a time.
  sendNotificationEmailBatch: (emails: unknown[]) =>
    Promise.all(emails.map((email) => mocks.sendEmail(email))),
}));

vi.mock("@hostel/db/models/Invoice", () => ({
  InvoiceModel: { find: mocks.invoiceFind, updateOne: mocks.invoiceUpdateOne },
}));
vi.mock("@hostel/db/models/InvoiceBalance", () => ({
  InvoiceBalanceModel: { find: mocks.balanceFind },
}));
vi.mock("@hostel/db/models/Resident", () => ({
  ResidentModel: { find: mocks.residentFind },
}));
vi.mock("@hostel/db/models/ReconciliationRun", () => ({
  ReconciliationRunModel: { create: mocks.runCreate, updateOne: mocks.runUpdateOne },
}));

import {
  type DunningStage,
  MAX_CHASES,
  nextDunningAction,
  runPaymentReminders,
} from "@/modules/finance/dunning.service";

const NOW = new Date(2026, 7, 20);

function ladder(overrides: Partial<Parameters<typeof nextDunningAction>[0]> = {}) {
  return nextDunningAction({
    chaseCount: 0,
    daysSinceLastNotice: null,
    daysUntilDue: 3,
    reminderDaysBefore: 7,
    stage: "NONE",
    ...overrides,
  });
}

describe("the ladder", () => {
  it("reminds three times before the bill is late", () => {
    // A week out, three days out, and the due day itself — the run-up a
    // resident can actually act on, since the money has to be moved.
    expect(ladder({ daysUntilDue: 7 })).toEqual({
      kind: "reminder",
      stage: "REMINDED",
    });
    expect(ladder({ daysUntilDue: 3, stage: "REMINDED" })).toEqual({
      kind: "reminder",
      stage: "REMINDED_SOON",
    });
    expect(ladder({ daysUntilDue: 0, stage: "REMINDED_SOON" })).toEqual({
      kind: "reminder",
      stage: "REMINDED_DUE",
    });
  });

  it("says nothing before the hostel's own window opens", () => {
    expect(ladder({ daysUntilDue: 8 })).toBeNull();
  });

  it("does not repeat a rung it has already climbed", () => {
    expect(ladder({ daysUntilDue: 5, stage: "REMINDED" })).toBeNull();
    expect(ladder({ daysUntilDue: 2, stage: "REMINDED_SOON" })).toBeNull();
    expect(ladder({ daysUntilDue: 0, stage: "REMINDED_DUE" })).toBeNull();
  });

  it("sends one email, not three, when the job reached the resident late", () => {
    /*
     * The defect this replaces: `daysUntilDue === 3` meant a run that missed
     * Tuesday skipped that resident permanently and silently. Every threshold
     * is `>=`, so a late run still finds a rung unclimbed — but it climbs to
     * the rung that is true *today* rather than walking up through the two that
     * stopped being true, which would send "due in a week" the morning the rent
     * is due.
     */
    expect(ladder({ daysUntilDue: 0, stage: "NONE" })).toEqual({
      kind: "reminder",
      stage: "REMINDED_DUE",
    });
    expect(ladder({ daysUntilDue: 1, stage: "NONE" })?.stage).toBe("REMINDED_SOON");
  });

  it("leaves the first two days late alone", () => {
    // A transfer that cleared yesterday and has not been verified yet is the
    // most common thing behind an invoice one day overdue.
    expect(ladder({ daysUntilDue: -1, stage: "REMINDED_DUE" })).toBeNull();
    expect(ladder({ daysUntilDue: -2, stage: "REMINDED_DUE" })).toBeNull();
  });

  it("sends the first overdue notice on day three, from any reminder rung", () => {
    for (const stage of ["NONE", "REMINDED", "REMINDED_SOON", "REMINDED_DUE"] as const) {
      expect(ladder({ daysUntilDue: -3, stage })).toEqual({
        kind: "overdue",
        stage: "OVERDUE_FIRST",
      });
    }
  });

  it("sends the second overdue notice a week late", () => {
    expect(ladder({ daysUntilDue: -6, stage: "OVERDUE_FIRST" })).toBeNull();
    expect(ladder({ daysUntilDue: -7, stage: "OVERDUE_FIRST" })?.stage).toBe(
      "OVERDUE_SECOND",
    );
  });

  it("chases weekly from the last notice, not from the due date", () => {
    // Otherwise a first run that happens a month late fires four chases in one
    // morning, which reads as a system malfunction to the resident.
    expect(
      ladder({ daysSinceLastNotice: 2, daysUntilDue: -30, stage: "OVERDUE_SECOND" }),
    ).toBeNull();
    expect(
      ladder({ daysSinceLastNotice: 7, daysUntilDue: -30, stage: "OVERDUE_SECOND" })?.kind,
    ).toBe("chase");
  });

  it("escalates to the hostel after the last chase", () => {
    expect(
      ladder({
        chaseCount: MAX_CHASES,
        daysSinceLastNotice: 9,
        daysUntilDue: -60,
        stage: "CHASING",
      }),
    ).toEqual({ kind: "escalate", stage: "ESCALATED" });
  });

  it("stops, and stays stopped", () => {
    expect(ladder({ daysUntilDue: -90, stage: "ESCALATED" })).toEqual({
      kind: "stop",
      stage: "STOPPED",
    });
    expect(ladder({ daysUntilDue: -900, stage: "STOPPED" })).toBeNull();
  });

  it("terminates from any starting rung within a bounded number of steps", () => {
    // The property, not a sequence of examples: no starting state loops.
    const stages: DunningStage[] = [
      "NONE",
      "REMINDED",
      "REMINDED_SOON",
      "REMINDED_DUE",
      "OVERDUE_FIRST",
      "OVERDUE_SECOND",
      "CHASING",
      "ESCALATED",
    ];

    for (const start of stages) {
      let stage = start;
      let chaseCount = 0;
      let steps = 0;

      for (;;) {
        const action = nextDunningAction({
          chaseCount,
          daysSinceLastNotice: 30,
          daysUntilDue: -365,
          reminderDaysBefore: 7,
          stage,
        });

        if (!action) break;

        stage = action.stage;
        if (action.kind === "chase") chaseCount += 1;
        steps += 1;

        expect(steps).toBeLessThan(20);
      }

      expect(stage).toBe("STOPPED");
    }
  });
});

/* -------------------------------------------------------------------------- */

function chain<T>(value: T) {
  return {
    lean: vi.fn().mockResolvedValue(value),
    limit: vi.fn().mockReturnThis(),
    sort: vi.fn().mockReturnThis(),
  };
}

function invoiceAt(index: number, overrides: Record<string, unknown> = {}) {
  const id = new Types.ObjectId(
    `64f0f0f0f0f0f0f0${index.toString(16).padStart(8, "0")}`,
  );

  return {
    _id: id,
    dueDate: new Date(2026, 7, 22),
    dunning: { chaseCount: 0, lastNotifiedAt: null, stage: "NONE" },
    hostelId,
    period: "2026-08",
    residentId: id,
    status: "OPEN",
    totalAmount: 8000,
    ...overrides,
  };
}

/** Pages `invoices` the way the cursor query would, 200 at a time. */
function wirePaging(invoices: ReturnType<typeof invoiceAt>[]) {
  mocks.invoiceFind.mockImplementation((filter: Record<string, unknown>) => {
    const after = (filter._id as { $gt?: Types.ObjectId } | undefined)?.$gt;
    const start = after
      ? invoices.findIndex((one) => one._id.equals(after)) + 1
      : 0;

    return chain(invoices.slice(start, start + 200));
  });
  mocks.residentFind.mockImplementation((filter: Record<string, unknown>) =>
    chain(
      ((filter._id as { $in: Types.ObjectId[] }).$in ?? []).map((id) => ({
        _id: id,
        firstName: "Resident",
        hostelId,
        lastName: id.toString().slice(-4),
        userId: id,
      })),
    ),
  );
  mocks.balanceFind.mockReturnValue(chain([]));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runCreate.mockResolvedValue({ _id: runId });
  mocks.runUpdateOne.mockResolvedValue({});
  mocks.invoiceUpdateOne.mockResolvedValue({});
  mocks.sendEmail.mockResolvedValue(true);
  mocks.adminContacts.mockResolvedValue([]);
  mocks.residentContact.mockResolvedValue({
    email: "resident@example.test",
    name: "Resident",
  });
});

describe("running the job", () => {
  it("reminds the resident at position 900, not just the first 500", async () => {
    // The old job's `.limit(500)` was platform-wide with no pagination: the
    // 501st open invoice was never chased and nothing said so.
    const invoices = Array.from({ length: 1000 }, (_, index) => invoiceAt(index));

    wirePaging(invoices);

    const result = await runPaymentReminders(NOW);

    expect(result.scanned).toBe(1000);
    expect(result.reminded).toBe(1000);

    const touched = mocks.invoiceUpdateOne.mock.calls.map((call) =>
      String(call[0]._id),
    );

    expect(touched).toContain(String(invoices[899]!._id));
  });

  it("records the stage on the invoice, so a re-run does not re-send", async () => {
    wirePaging([invoiceAt(1)]);

    await runPaymentReminders(NOW);

    const staged = mocks.invoiceUpdateOne.mock.calls.find(
      (call) => call[1]?.$set?.["dunning.stage"],
    );

    // Two days out, so the run-up's second rung rather than its first.
    expect(staged?.[1].$set["dunning.stage"]).toBe("REMINDED_SOON");
    expect(staged?.[1].$set["dunning.lastNotifiedAt"]).toEqual(NOW);
  });

  it("counts a chase and leaves the count alone otherwise", async () => {
    wirePaging([
      invoiceAt(2, {
        dueDate: new Date(2026, 6, 1),
        dunning: {
          chaseCount: 1,
          lastNotifiedAt: new Date(2026, 7, 1),
          stage: "CHASING",
        },
        status: "OVERDUE",
      }),
    ]);

    await runPaymentReminders(NOW);

    const call = mocks.invoiceUpdateOne.mock.calls.find(
      (one) => one[1]?.$inc?.["dunning.chaseCount"],
    );

    expect(call?.[1].$inc["dunning.chaseCount"]).toBe(1);
  });

  it("tells the hostel, not the resident, when the ladder runs out", async () => {
    mocks.adminContacts.mockResolvedValue([
      { email: "owner@example.test", userId: new Types.ObjectId() },
    ]);
    wirePaging([
      invoiceAt(3, {
        dueDate: new Date(2026, 5, 1),
        dunning: {
          chaseCount: MAX_CHASES,
          lastNotifiedAt: new Date(2026, 7, 1),
          stage: "CHASING",
        },
        status: "OVERDUE",
      }),
    ]);

    const result = await runPaymentReminders(NOW);

    expect(result.escalated).toBe(1);
    expect(mocks.createNotification.mock.calls[0]?.[0].title).toBe(
      "Unpaid fee needs your attention",
    );
  });

  it("puts the three-days-out rung in the bell only", async () => {
    wirePaging([invoiceAt(7)]);

    const result = await runPaymentReminders(NOW);

    expect(result.reminded).toBe(1);
    expect(mocks.createNotification).toHaveBeenCalledOnce();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("emails a resident once per run, however many bills moved", async () => {
    const residentId = new Types.ObjectId();

    wirePaging([
      invoiceAt(8, { dueDate: NOW, residentId }),
      invoiceAt(9, { dueDate: new Date(2026, 7, 10), residentId, status: "OVERDUE" }),
    ]);

    const result = await runPaymentReminders(NOW);

    expect(result.reminded + result.overdueNotified).toBe(2);
    expect(mocks.createNotification).toHaveBeenCalledTimes(2);
    expect(mocks.sendEmail).toHaveBeenCalledOnce();
    expect(mocks.sendEmail.mock.calls[0]![0].action).toBe("payment_overdue");
  });

  it("tells an owner about every escalated resident in one email", async () => {
    mocks.adminContacts.mockResolvedValue([
      { email: "owner@example.test", userId: new Types.ObjectId() },
    ]);
    const exhausted = {
      dueDate: new Date(2026, 5, 1),
      dunning: { chaseCount: MAX_CHASES, lastNotifiedAt: new Date(2026, 7, 1), stage: "CHASING" },
      status: "OVERDUE",
    };
    wirePaging([invoiceAt(10, exhausted), invoiceAt(11, exhausted)]);

    const result = await runPaymentReminders(NOW);

    expect(result.escalated).toBe(2);
    expect(mocks.createNotification).toHaveBeenCalledTimes(2);
    expect(mocks.sendEmail).toHaveBeenCalledOnce();
    const { html } = mocks.sendEmail.mock.calls[0]![0];
    expect(html).toContain("Resident 000a");
    expect(html).toContain("Resident 000b");
  });

  it("sends nothing at all once the invoice is stopped", async () => {
    wirePaging([
      invoiceAt(4, {
        dueDate: new Date(2026, 4, 1),
        dunning: { chaseCount: MAX_CHASES, lastNotifiedAt: NOW, stage: "STOPPED" },
        status: "OVERDUE",
      }),
    ]);

    await runPaymentReminders(NOW);

    expect(mocks.createNotification).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("writes a run row, so a job that stops working is visible", async () => {
    wirePaging([invoiceAt(5)]);

    await runPaymentReminders(NOW);

    expect(mocks.runCreate).toHaveBeenCalledOnce();
    expect(mocks.runUpdateOne.mock.calls.at(-1)?.[1].$set.counters.scanned).toBe(1);
  });

  it("does not advance the stage when the send failed", async () => {
    // Otherwise a transient email failure silently skips a rung, and the
    // resident is never told at that stage — the same class of bug as the
    // exact-day equality this rebuild removed.
    mocks.residentContact.mockRejectedValue(new Error("smtp down"));
    wirePaging([invoiceAt(6, { dueDate: NOW })]);

    const result = await runPaymentReminders(NOW);

    expect(result.reminded).toBe(0);
    expect(
      mocks.invoiceUpdateOne.mock.calls.some(
        (call) => call[1]?.$set?.["dunning.stage"],
      ),
    ).toBe(false);
  });
});
