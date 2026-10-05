import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import { getBranchesSummary } from "@/lib/admin-api";
import { getOverallData, getOverallLedger } from "@/lib/overall-api";

vi.mock("@/lib/api", () => ({ api: { get: vi.fn() } }));
vi.mock("@/lib/admin-api", () => ({ getBranchesSummary: vi.fn() }));

const branches = [
  { id: "main", name: "Main", isBranch: false, beds: 10, collected: 100, due: 20, residents: 4, openComplaints: 1 },
  { id: "north", name: "North", isBranch: true, beds: 8, collected: 70, due: 10, residents: 3, openComplaints: 0 },
];

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getBranchesSummary).mockResolvedValue({ hostels: branches as never, period: "2083-06" });
});

describe("overall branch reads", () => {
  it("requests each people source under that branch's explicit scope", async () => {
    vi.mocked(api.get).mockImplementation(async (path, config) => ({
      data: { data: path === "/hostel-admin/residents" ? { residents: [] } : path === "/hostel-admin/wardens" ? { wardens: [] } : { cooks: [] } },
      config,
    }) as never);

    const result = await getOverallData("people", "2083-06");

    expect(result.section).toBe("people");
    expect(result.branches.map((row) => row.branch.id)).toEqual(["main", "north"]);
    expect(api.get).toHaveBeenCalledTimes(6);
    expect(vi.mocked(api.get).mock.calls.map(([path, config]) => [path, config?.headers?.["x-hostel-id"]])).toEqual([
      ["/hostel-admin/residents", "main"],
      ["/hostel-admin/wardens", "main"],
      ["/hostel-admin/cooks", "main"],
      ["/hostel-admin/residents", "north"],
      ["/hostel-admin/wardens", "north"],
      ["/hostel-admin/cooks", "north"],
    ]);
  });

  it("keeps a failed branch field distinct from an empty successful field", async () => {
    vi.mocked(api.get).mockImplementation(async (path, config) => {
      if (path === "/hostel-admin/cooks" && config?.headers?.["x-hostel-id"] === "north") {
        throw new Error("unavailable");
      }
      return { data: { data: path === "/hostel-admin/residents" ? { residents: [] } : path === "/hostel-admin/wardens" ? { wardens: [] } : { cooks: [] } } } as never;
    });

    const result = await getOverallData("people", "2083-06");

    expect(result.branches[0]?.fields.cooks?.data).toEqual({ cooks: [] });
    expect(result.branches[1]?.fields.cooks?.data).toBeNull();
    expect(result.branches[1]?.fields.cooks?.error).toBeTruthy();
    expect(result.branches[1]?.fields.residents?.data).toEqual({ residents: [] });
  });

  it("reads shared plan billing once from the main hostel", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { data: {} } } as never);

    const result = await getOverallData("money", "2083-06");

    expect(result.section).toBe("money");
    expect(vi.mocked(api.get).mock.calls.filter(([path]) => path === "/hostel-admin/billing")
      .map(([, config]) => config?.headers?.["x-hostel-id"])).toEqual(["main"]);
    expect(result.branches[1]?.fields.billing).toBeUndefined();
  });
});

describe("overall statement", () => {
  it("merges every branch's ledger, tagging rows and keeping ids apart", async () => {
    vi.mocked(api.get).mockImplementation(async (_path, config) => {
      const id = config?.headers?.["x-hostel-id"];
      return {
        data: {
          data: {
            entries: [{ id: "inv1", paidAmount: id === "main" ? 100 : 70, residentName: id }],
            expenses: [{ id: "exp1", amount: 5 }],
            truncated: id === "north",
          },
        },
      } as never;
    });

    const ledger = await getOverallLedger();

    expect(ledger.entries.map((entry) => [entry.id, entry.branch?.name, entry.paidAmount])).toEqual([
      ["main:inv1", "Main", 100],
      ["north:inv1", "North", 70],
    ]);
    expect(ledger.expenses?.map((expense) => expense.id)).toEqual(["main:exp1", "north:exp1"]);
    expect(ledger.truncated).toBe(true);
  });

  it("fails whole when one branch fails, rather than under-reporting", async () => {
    vi.mocked(api.get).mockImplementation(async (_path, config) => {
      if (config?.headers?.["x-hostel-id"] === "north") throw new Error("boom");
      return { data: { data: { entries: [], expenses: null, truncated: false } } } as never;
    });

    await expect(getOverallLedger()).rejects.toThrow(/North/);
  });
});
