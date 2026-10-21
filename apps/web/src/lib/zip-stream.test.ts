import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";

import { safeEntryName, zipStream, type ZipEntry } from "@/lib/zip-stream";

async function* chunks(...parts: string[]) {
  for (const part of parts) yield new TextEncoder().encode(part);
}

async function build(entries: ZipEntry[]) {
  const out: Uint8Array[] = [];

  for await (const chunk of zipStream(entries)) out.push(chunk);

  return Buffer.concat(out);
}

/** Reads the archive back the way an unzip tool does: end record → central directory → data. */
function readZip(zip: Buffer) {
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);

  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const files: Record<string, string> = {};

  for (let index = 0; index < count; index += 1) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const crc = zip.readUInt32LE(at + 16);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const localOffset = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");

    expect(zip.readUInt32LE(localOffset)).toBe(0x04034b50);
    const start = localOffset + 30 + zip.readUInt16LE(localOffset + 26);
    const data = zip.subarray(start, start + size);

    expect(crc32(data) >>> 0).toBe(crc);
    files[name] = data.toString("utf8");
    at += 46 + nameLength;
  }

  return files;
}

describe("zipStream", () => {
  it("writes entries an unzip tool reads back byte for byte", async () => {
    const date = new Date(2026, 9, 21, 18, 30);
    const zip = await build([
      { data: chunks("hello ", "world"), date, name: "Photos/a.txt" },
      { data: chunks("नमस्ते"), date, name: "Documents/नेपाली.txt" },
      { data: chunks(), date, name: "empty.txt" },
    ]);

    expect(readZip(zip)).toEqual({
      "Documents/नेपाली.txt": "नमस्ते",
      "Photos/a.txt": "hello world",
      "empty.txt": "",
    });
  });

  it("makes names safe on every system", () => {
    expect(safeEntryName('a/b\\c:d*e?"f<g>h|i')).toBe("a-b-c-d-e--f-g-h-i");
    expect(safeEntryName("   ")).toBe("file");
  });
});
