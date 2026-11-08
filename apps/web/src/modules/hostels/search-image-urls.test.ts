import { describe, expect, it } from "vitest";

import { photoAssetId } from "@/modules/hostels/search-image-urls";

describe("photoAssetId", () => {
  it("reads the asset id from a stored photo path, and nothing else", () => {
    expect(photoAssetId("/api/v1/files/6a681104ec06f6c562c2cf10/url")).toBe(
      "6a681104ec06f6c562c2cf10",
    );
    expect(photoAssetId("/api/v1/files/6a681104ec06f6c562c2cf10/url?variant=LARGE")).toBe(
      "6a681104ec06f6c562c2cf10",
    );
    expect(photoAssetId("https://media.softmato.com/hostel/a.jpg")).toBeNull();
    expect(photoAssetId("/api/v1/files/not-an-id/url")).toBeNull();
    expect(photoAssetId("/api/v1/files/6a681104ec06f6c562c2cf10/optimize")).toBeNull();
  });
});
