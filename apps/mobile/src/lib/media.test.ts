import { describe, expect, it } from "vitest";

import { absoluteMediaUrl } from "@/lib/media";

const BASE = "http://192.168.1.14:3000";

describe("absoluteMediaUrl", () => {
  it("gives a stored relative photo path an origin", () => {
    expect(absoluteMediaUrl("/api/v1/files/abc123/url", BASE)).toBe(
      "http://192.168.1.14:3000/api/v1/files/abc123/url",
    );
  });

  it("puts the website's own files on the site, not the API", () => {
    expect(absoluteMediaUrl("/mockups/admin.webp", BASE)).toBe("https://hostelpalika.com/mockups/admin.webp");
  });

  it("keeps the query string that selects a variant", () => {
    expect(absoluteMediaUrl("/api/v1/files/abc123/url?variant=MEDIUM", BASE)).toBe(
      "http://192.168.1.14:3000/api/v1/files/abc123/url?variant=MEDIUM",
    );
  });

  it("leaves the demo hostels' absolute Unsplash URLs alone", () => {
    const unsplash = "https://images.unsplash.com/photo-123?w=800";

    expect(absoluteMediaUrl(unsplash, BASE)).toBe(unsplash);
  });

  it("leaves http, data and file URIs alone", () => {
    expect(absoluteMediaUrl("http://cdn.test/a.png", BASE)).toBe("http://cdn.test/a.png");
    expect(absoluteMediaUrl("data:image/png;base64,AAA", BASE)).toBe(
      "data:image/png;base64,AAA",
    );
    expect(absoluteMediaUrl("file:///storage/a.jpg", BASE)).toBe("file:///storage/a.jpg");
  });

  it("leaves a protocol-relative URL alone", () => {
    expect(absoluteMediaUrl("//cdn.test/a.png", BASE)).toBe("//cdn.test/a.png");
  });

  it("does not double the slash when the base carries one", () => {
    expect(absoluteMediaUrl("/api/v1/files/a/url", `${BASE}/`)).toBe(
      "http://192.168.1.14:3000/api/v1/files/a/url",
    );
  });

  it("adds the missing slash on a path stored without one", () => {
    expect(absoluteMediaUrl("api/v1/files/a/url", BASE)).toBe(
      "http://192.168.1.14:3000/api/v1/files/a/url",
    );
  });

  it("returns null for nothing, rather than pointing at the origin root", () => {
    // An <Image> aimed at the bare origin fetches the HTML homepage and tries
    // to decode it as an image.
    expect(absoluteMediaUrl(null, BASE)).toBeNull();
    expect(absoluteMediaUrl(undefined, BASE)).toBeNull();
    expect(absoluteMediaUrl("", BASE)).toBeNull();
    expect(absoluteMediaUrl("   ", BASE)).toBeNull();
  });
});
