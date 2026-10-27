import { beforeEach, describe, expect, it, vi } from "vitest";

const offline = Object.assign(new Error("net"), { request: {}, response: undefined });
const addStockEntry = vi.fn();

vi.mock("react-native", () => ({ AppState: { addEventListener: () => ({ remove() {} }) } }));
// The PWA twin keeps rows in memory when IndexedDB is absent — the same API as the phone.
vi.mock("@/lib/local-db", () => import("../../web/local-db"));
vi.mock("@/lib/stock-api", () => ({ addStockEntry: (...args: unknown[]) => addStockEntry(...args) }));
vi.mock("@/lib/complaints-api", () => ({ createResidentComplaint: vi.fn() }));
vi.mock("@/lib/expenses-api", () => ({ addExpense: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

import { listQueuedWrites } from "@/lib/local-db";
import { flushOfflineWrites, sendOrQueue } from "@/lib/offline-writes";

const entry = { clientRequestId: "req-12345678", kind: "USE" as const, lines: [{ itemId: "i1", qty: 2 }] };

describe("offline writes", () => {
  beforeEach(() => {
    addStockEntry.mockReset();
  });

  it("queues on a network failure, sends in order when back, drops a refusal", async () => {
    addStockEntry.mockImplementation(async () => { throw offline; });
    expect(await sendOrQueue("stock", entry)).toBe("queued");
    expect(await sendOrQueue("stock", { ...entry, clientRequestId: "req-87654321" })).toBe("queued");
    expect(listQueuedWrites("stock")).toHaveLength(2);

    await flushOfflineWrites();
    expect(listQueuedWrites()).toHaveLength(2);

    addStockEntry
      .mockImplementationOnce(async () => ({}))
      .mockImplementationOnce(async () => { throw { response: { data: { message: "Month closed" } } }; });
    await flushOfflineWrites();
    expect(addStockEntry.mock.calls.at(-2)?.[0]).toEqual(entry);
    expect(listQueuedWrites()).toHaveLength(0);
  });

  it("throws a server refusal instead of queueing it", async () => {
    addStockEntry.mockImplementation(async () => { throw { response: { data: { message: "No such item" } } }; });
    await expect(sendOrQueue("stock", entry)).rejects.toBeTruthy();
    expect(listQueuedWrites()).toHaveLength(0);
  });
});
