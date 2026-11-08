import { describe, expect, it } from "vitest";

import { hostelPhotoCreateSchema, platformHostelCreateSchema } from "@/lib/hostels/hostel.validation";

/**
 * Photo `url`s are **stored**, so both clients deliberately send a relative
 * `/api/v1/files/<id>/url` — an origin baked into the record follows the photo
 * forever, and a photo uploaded from a dev machine sent every production
 * visitor to their own localhost.
 *
 * The schema used to be `z.string().url()`, which rejects exactly that. Every
 * hostel photo upload — the admin profile gallery on web and mobile, and the
 * per-room shots — 422'd with `Invalid URL`. These tests pin the shape the
 * clients actually build.
 */
describe("hostelPhotoCreateSchema", () => {
  const assetId = "6a8e766ef8a166d716953651";

  it("accepts the relative files path both clients send", () => {
    const parsed = hostelPhotoCreateSchema.parse({
      fileAssetId: assetId,
      kind: "EXTERIOR",
      url: `/api/v1/files/${assetId}/url`,
    });

    expect(parsed.url).toBe(`/api/v1/files/${assetId}/url`);
  });

  it("still accepts an absolute link for media hosted elsewhere", () => {
    expect(
      hostelPhotoCreateSchema.parse({
        kind: "INTERIOR",
        url: "https://cdn.example.com/photo.jpg",
      }).url,
    ).toBe("https://cdn.example.com/photo.jpg");
  });

  it("rejects a bare key, which would resolve against nothing", () => {
    expect(() =>
      hostelPhotoCreateSchema.parse({ kind: "INTERIOR", url: "hostels/abc/photo.jpg" }),
    ).toThrow();
  });

  it("still requires a room type on a room photo", () => {
    expect(() =>
      hostelPhotoCreateSchema.parse({ kind: "ROOM", url: `/api/v1/files/${assetId}/url` }),
    ).toThrow();
  });
});

describe("platformHostelCreateSchema photos", () => {
  it("takes the same relative path in the create payload", () => {
    const parsed = platformHostelCreateSchema.parse({
      location: { area: "Baneshwor" },
      name: "Test Hostel",
      ownerId: "6a8e766ef8a166d716953651",
      photos: [{ url: "/api/v1/files/6a8e766ef8a166d716953651/url" }],
    });

    expect(parsed.photos).toHaveLength(1);
  });
});
