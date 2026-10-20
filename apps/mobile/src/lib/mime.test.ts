import { describe, expect, it } from "vitest";

import { resolveFileName, resolveMimeType } from "@/lib/mime";

/**
 * R2 signs the `Content-Type` into the presigned URL, so a mismatch between
 * what we declare at presign and what we send on the PUT fails with a
 * signature error that says nothing about types. Resolving it once is the fix.
 */
describe("resolveMimeType", () => {
  it("trusts the picker when it gives one", () => {
    expect(resolveMimeType({ mimeType: "image/png", uri: "file:///x.jpg" })).toBe(
      "image/png",
    );
  });

  it("falls back to the file name's extension", () => {
    expect(resolveMimeType({ fileName: "receipt.PNG", uri: "file:///tmp/abc" })).toBe(
      "image/png",
    );
  });

  it("reads the extension off the uri when there is no file name", () => {
    expect(resolveMimeType({ uri: "file:///tmp/photo.heic" })).toBe("image/heic");
  });

  it("knows a clip by its extension, so a video is never declared a JPEG", () => {
    expect(resolveMimeType({ uri: "file:///tmp/clip.MOV" })).toBe("video/quicktime");
  });

  it("ignores a query string on the uri", () => {
    // Android content:// and cached picker uris routinely carry one.
    expect(resolveMimeType({ uri: "file:///tmp/photo.webp?width=100" })).toBe(
      "image/webp",
    );
  });

  it("defaults to jpeg rather than sending nothing", () => {
    expect(resolveMimeType({ uri: "content://media/external/images/42" })).toBe(
      "image/jpeg",
    );
  });
});

describe("resolveFileName", () => {
  it("keeps the picker's name", () => {
    expect(resolveFileName({ fileName: "esewa.png", uri: "file:///x" })).toBe(
      "esewa.png",
    );
  });

  it("invents a unique name with the right extension when there is none", () => {
    const name = resolveFileName({ mimeType: "image/png", uri: "content://media/42" });

    expect(name).toMatch(/^upload-\d+\.png$/);
  });
});
