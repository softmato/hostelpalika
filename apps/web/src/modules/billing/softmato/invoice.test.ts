import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The contract with Softmato's `POST /invoices`, as its validator enforces it.
 * Every plan invoice — regular, lifetime, setup fee, team prepayment, balance
 * document — reaches Softmato through `ensureSoftmatoInvoice`, so the rules are
 * held here once rather than at each caller.
 */
const mocks = vi.hoisted(() => ({ createInvoice: vi.fn() }));

vi.mock("./client", () => ({ softmato: () => ({ createInvoice: mocks.createInvoice }) }));

const { ensureSoftmatoInvoice } = await import("./invoice");

const BASE = {
  amount: 24_999,
  customer: { hostelId: "6ac9176a53bf67e77fb8affc", name: "test 3" },
  description: "Max — Lifetime",
  invoiceNumber: "SUB-0001-AFFC",
};

function sent() {
  return mocks.createInvoice.mock.calls[0]?.[0] as Record<string, unknown>;
}

describe("ensureSoftmatoInvoice", () => {
  beforeEach(() => {
    mocks.createInvoice.mockReset();
    mocks.createInvoice.mockResolvedValue({ invoice_id: "inv_1", invoice_no: "INV-2083/84-000020" });
  });

  it("never sends half a service period — Softmato refuses it (the lifetime outage)", async () => {
    await ensureSoftmatoInvoice({ ...BASE, serviceStartsAt: new Date("2026-10-09T00:00:00Z") });

    expect(sent()).not.toHaveProperty("service_starts_at");
    expect(sent()).not.toHaveProperty("service_ends_at");
  });

  it("sends a whole service period as both ends", async () => {
    await ensureSoftmatoInvoice({
      ...BASE,
      serviceEndsAt: new Date("2026-11-15T18:14:59Z"),
      serviceStartsAt: new Date("2026-10-09T00:00:00Z"),
    });

    expect(sent()).toMatchObject({
      service_ends_at: "2026-11-15T18:14:59.000Z",
      service_starts_at: "2026-10-09T00:00:00.000Z",
    });
  });

  it("sends a due date only while it is still ahead", async () => {
    await ensureSoftmatoInvoice({ ...BASE, dueAt: new Date(Date.now() - 86_400_000) });
    expect(sent()).not.toHaveProperty("due_at");

    mocks.createInvoice.mockClear();
    const ahead = new Date(Date.now() + 86_400_000);
    await ensureSoftmatoInvoice({ ...BASE, dueAt: ahead });
    expect(sent()).toMatchObject({ due_at: ahead.toISOString() });
  });

  it("prices the line in paisa, whole", async () => {
    await ensureSoftmatoInvoice(BASE);

    expect(sent()).toMatchObject({
      lines: [{ description: "Max — Lifetime", quantity: 1, unit_price_minor: 2_499_900 }],
    });
  });
});
