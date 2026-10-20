import { describe, expect, it } from "vitest";

import {
  acceptAttribute,
  formatBytes,
  uploadHint,
  validateFileForUpload,
} from "@/lib/uploads/accepts";

function fakeFile(name: string, type: string, size: number) {
  const file = new File(["x"], name, { type });

  // `File` derives size from its contents; override it so a test can describe a
  // 6 MB upload without allocating 6 MB.
  Object.defineProperty(file, "size", { value: size });

  return file;
}

const MB = 1024 * 1024;

describe("upload accept rules", () => {
  it("advertises the platform's accepted MIME types per kind", () => {
    expect(acceptAttribute("image").split(",")).toEqual([
      "image/jpeg",
      "image/png",
      "image/webp",
    ]);
    expect(acceptAttribute("document")).toContain("application/pdf");
    expect(acceptAttribute("any")).toContain("text/plain");
  });

  it("lets a call site narrow the accept list", () => {
    expect(acceptAttribute("document", "image/png")).toBe("image/png");
  });

  it("accepts allowed files within their size limit", () => {
    expect(
      validateFileForUpload(fakeFile("a.png", "image/png", 4 * MB), { kind: "image" }),
    ).toBeNull();
    expect(
      validateFileForUpload(fakeFile("a.pdf", "application/pdf", 9 * MB), {
        kind: "document",
      }),
    ).toBeNull();
  });

  it("rejects a MIME type the platform does not accept", () => {
    expect(
      validateFileForUpload(fakeFile("a.exe", "application/x-msdownload", 10), {
        kind: "any",
      }),
    ).toContain("not an accepted file type");
  });

  it("rejects a type excluded by a narrowed accept list", () => {
    expect(
      validateFileForUpload(fakeFile("a.pdf", "application/pdf", 10), {
        accept: "image/png",
        kind: "document",
      }),
    ).toContain("not an accepted file type");
  });

  it("reads image/* as the image types the server takes, not every subtype", () => {
    expect(
      validateFileForUpload(fakeFile("a.jpg", "image/jpeg", 10), { accept: "image/*" }),
    ).toBeNull();
    expect(
      validateFileForUpload(fakeFile("a.heic", "image/heic", 10), { accept: "image/*" }),
    ).toContain("Allowed: JPG, PNG or WebP up to 5 MB");
  });

  it("holds images to the tighter image limit even inside a document field", () => {
    // 6 MB is under the 10 MB document cap but over the 5 MB image cap.
    expect(
      validateFileForUpload(fakeFile("big.png", "image/png", 6 * MB), {
        kind: "document",
      }),
    ).toContain("the limit is 5 MB");
  });

  it("rejects empty and untyped files", () => {
    expect(
      validateFileForUpload(fakeFile("a.png", "image/png", 0), { kind: "image" }),
    ).toContain("is empty");
    expect(validateFileForUpload(fakeFile("a", "", 10), { kind: "any" })).toContain(
      "unrecognised file type",
    );
  });
});

describe("upload hint copy", () => {
  it("names the types and the single limit that applies", () => {
    expect(uploadHint("image")).toBe("JPG, PNG or WebP up to 5 MB");
  });

  it("spells out both limits when images and documents are mixed", () => {
    expect(uploadHint("document", "image/png,application/pdf")).toBe(
      "PNG up to 5 MB · PDF up to 10 MB",
    );
  });
});

describe("formatBytes", () => {
  it("renders human sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(900)).toBe("900 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * MB)).toBe("5 MB");
  });
});
