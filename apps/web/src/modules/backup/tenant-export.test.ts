import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { Types } from "mongoose";
import { describe, expect, it } from "vitest";

import {
  buildTenantExport,
  EXCLUDED,
  CHUNK_BYTES,
  packTenantExport,
  parseChunk,
  sha256Hex,
  TENANT_COLLECTIONS,
  type TenantSource,
} from "./tenant-export";

const MODELS = path.resolve(__dirname, "../../../../../packages/db/src/models");

describe("tenant export map", () => {
  it("lists every model that carries a hostel, exported or excluded with a reason", () => {
    const tenantModels = readdirSync(MODELS)
      .filter((file) => file.endsWith(".ts"))
      .filter((file) => /^\s+(hostelId|groupHostelId|hostelIds):/m.test(readFileSync(path.join(MODELS, file), "utf8")))
      .map((file) => file.replace(/\.ts$/, ""));
    const mapped = new Set([...TENANT_COLLECTIONS.map((entry) => entry.name), ...Object.keys(EXCLUDED)]);

    expect(tenantModels.filter((name) => !mapped.has(name))).toEqual([]);
  });

  it("reads each collection by a field its schema really has", () => {
    for (const entry of TENANT_COLLECTIONS) {
      expect(entry.model.schema.path(entry.key), `${entry.name}.${entry.key}`).toBeTruthy();
    }
  });
});

/* An in-memory Mongo that understands the only filter shape the export may use. */
type Row = Record<string, unknown>;

function memorySource(data: Record<string, Row[]>): TenantSource {
  const matches = (row: Row, filter: Row) =>
    Object.entries(filter).every(([key, condition]) => {
      const value = row[key];
      const wanted = (condition as { $in?: unknown[] })?.$in ?? [condition];
      const values = Array.isArray(value) ? value : [value];

      return values.some((one) => wanted.some((want) => String(want) === String(one)));
    });

  return { find: async (entry, filter) => (data[entry.name] ?? []).filter((row) => matches(row, filter)) };
}

describe("buildTenantExport", () => {
  const A = new Types.ObjectId();
  const A1 = new Types.ObjectId(); // A's branch
  const B = new Types.ObjectId();
  const B1 = new Types.ObjectId(); // B's branch
  const row = (hostelId: Types.ObjectId, extra: Row = {}) => ({ _id: new Types.ObjectId(), hostelId, ...extra });

  const makeData = (): Record<string, Row[]> => ({
    Expense: [row(A), row(B1)],
    Hostel: [
      { _id: A, parentHostelId: null },
      { _id: A1, parentHostelId: A },
      { _id: B, parentHostelId: null },
      { _id: B1, parentHostelId: B },
    ],
    Invoice: [row(A), row(A1), row(B), row(B1)],
    Resident: [row(A, { firstName: "Asha" }), row(A1), row(B, { firstName: "Bina" }), row(B1)],
    StockItem: [
      { _id: new Types.ObjectId(), groupHostelId: A },
      { _id: new Types.ObjectId(), groupHostelId: B },
    ],
    User: [
      { _id: new Types.ObjectId(), hostelIds: [A] },
      { _id: new Types.ObjectId(), hostelIds: [B] },
      { _id: new Types.ObjectId(), hostelIds: [A1, B] },
    ],
  });

  it("holds the main hostel and its branches, and nothing of another hostel", async () => {
    const result = await buildTenantExport(A, memorySource(makeData()));
    const text = packTenantExport(result).bytes.toString("utf8");

    expect(result.hostelIds.sort()).toEqual([A, A1].map(String).sort());
    expect(result.counts).toMatchObject({ Expense: 1, Hostel: 2, Invoice: 2, Resident: 2, StockItem: 1 });
    expect(text).not.toContain(B.toString());
    expect(text).not.toContain(B1.toString());
    expect(text).not.toContain("Bina");
  });

  it("a branch exports only itself", async () => {
    const result = await buildTenantExport(A1, memorySource(makeData()));

    expect(result.hostelIds).toEqual([A1.toString()]);
    expect(result.counts).toMatchObject({ Hostel: 1, Invoice: 1, Resident: 1 });
    // Its own Hostel row names its parent; no row of the parent's comes along.
    expect(result.collections.Resident?.every((resident) => String(resident.hostelId) === String(A1))).toBe(true);
    expect(packTenantExport(result).bytes.toString("utf8")).not.toContain("Asha");
  });

  it("a user shared with another hostel is listed with only this hostel's ids", async () => {
    const result = await buildTenantExport(A, memorySource(makeData()));

    expect(result.collections.User).toHaveLength(2);
    expect(result.collections.User?.[1]?.hostelIds).toEqual([A1]);
  });

  it("packs into hashed chunks that round-trip ids and dates", async () => {
    const result = await buildTenantExport(B, memorySource(makeData()), new Date("2026-10-27T00:00:00Z"));
    const { bytes, chunks } = packTenantExport(result);
    const archive = JSON.parse(bytes.toString("utf8"));
    const invoice = archive.chunks.find((chunk: { collection: string }) => chunk.collection === "Invoice");

    expect(archive.createdAt).toBe("2026-10-27T00:00:00.000Z");
    expect(parseChunk(invoice.data)[0]?._id).toBeInstanceOf(Types.ObjectId);
    expect(chunks.find((chunk) => chunk.collection === "Invoice")?.sha256).toBe(sha256Hex(Buffer.from(invoice.data, "utf8")));
  });

  it("splits a large collection across chunks", () => {
    const rows = Array.from({ length: 30 }, () => ({ _id: new Types.ObjectId(), note: "x".repeat(CHUNK_BYTES / 10) }));
    const { chunks } = packTenantExport({
      collections: { Expense: rows },
      counts: {},
      createdAt: "",
      format: "hostelpalika-tenant-export",
      hostelId: "",
      hostelIds: [],
      version: 1,
    });

    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.reduce((total, chunk) => total + chunk.rows, 0)).toBe(30);
  });
});
