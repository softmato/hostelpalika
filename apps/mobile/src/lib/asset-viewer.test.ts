import { beforeEach, describe, expect, it } from "vitest";

import {
  clampIndex,
  closeAssetViewer,
  getAssetViewerState,
  isOnDevice,
  isPreviewable,
  isVideo,
  openAssetViewer,
  setAssetViewerIndex,
  subscribeToAssetViewer,
  viewerFileName,
  viewerSourceFor,
} from "@/lib/asset-viewer";

const BASE = "http://192.168.1.14:3000";

beforeEach(() => {
  closeAssetViewer();
});

describe("clampIndex", () => {
  it("keeps an in-range index", () => {
    expect(clampIndex(2, 5)).toBe(2);
  });

  it("pulls an out-of-range index back to the collection", () => {
    // The list refreshed between render and tap and is shorter than it was.
    expect(clampIndex(9, 3)).toBe(2);
    expect(clampIndex(-1, 3)).toBe(0);
  });

  it("survives an empty collection", () => {
    expect(clampIndex(4, 0)).toBe(0);
  });

  it("survives a non-numeric index", () => {
    expect(clampIndex(Number.NaN, 3)).toBe(0);
  });
});

describe("isPreviewable", () => {
  it("draws images", () => {
    expect(isPreviewable({ mimeType: "image/jpeg", url: "x" })).toBe(true);
    expect(isPreviewable({ mimeType: "image/heic", url: "x" })).toBe(true);
  });

  it("treats an unknown type as an image, because every caller passes one", () => {
    expect(isPreviewable({ url: "x" })).toBe(true);
  });

  it("hands off a type it cannot draw", () => {
    expect(isPreviewable({ mimeType: "application/pdf", url: "x" })).toBe(false);
  });

  it("plays a clip rather than handing it off", () => {
    expect(isPreviewable({ mimeType: "video/mp4", url: "x" })).toBe(true);
    expect(isVideo({ mimeType: "video/quicktime", url: "x" })).toBe(true);
    expect(isVideo({ mimeType: "image/png", url: "x" })).toBe(false);
  });
});

describe("isOnDevice", () => {
  it("knows a just-picked file from one on the server", () => {
    expect(isOnDevice({ url: "file:///data/user/0/cache/clip.mp4" })).toBe(true);
    expect(isOnDevice({ url: "https://cdn.example.com/a.jpg" })).toBe(false);
    expect(isOnDevice({ assetId: "abc" })).toBe(false);
  });
});

describe("viewerSourceFor", () => {
  it("authorises a private asset against our own route", () => {
    expect(viewerSourceFor({ assetId: "abc" }, { baseUrl: BASE, token: "t0ken" })).toEqual({
      headers: { Authorization: "Bearer t0ken" },
      uri: `${BASE}/api/v1/files/abc/url`,
    });
  });

  it("still builds the private URL with no token, so the 401 is visible", () => {
    const source = viewerSourceFor({ assetId: "abc" }, { baseUrl: BASE, token: null });

    expect(source?.headers).toBeUndefined();
    expect(source?.uri).toBe(`${BASE}/api/v1/files/abc/url`);
  });

  it("never sends an Authorization header to a public URL", () => {
    // R2 reads any Authorization header as SigV4 and rejects the request; this
    // is the branch that breaks every working image if it grows a header.
    const source = viewerSourceFor(
      { url: "https://images.unsplash.com/photo-1" },
      { baseUrl: BASE, token: "t0ken" },
    );

    expect(source).toEqual({ uri: "https://images.unsplash.com/photo-1" });
  });

  it("resolves an API-relative stored path against the API origin", () => {
    expect(
      viewerSourceFor({ url: "/api/v1/files/xyz/url" }, { baseUrl: BASE, token: null }),
    ).toEqual({ uri: `${BASE}/api/v1/files/xyz/url` });
  });

  it("prefers the asset id when an item carries both", () => {
    const source = viewerSourceFor(
      { assetId: "abc", url: "https://r2.example/signed" },
      { baseUrl: BASE, token: "t0ken" },
    );

    expect(source?.uri).toBe(`${BASE}/api/v1/files/abc/url`);
  });

  it("reports nothing to load rather than pointing at the origin root", () => {
    expect(viewerSourceFor({ url: "" }, { baseUrl: BASE, token: null })).toBeNull();
    expect(viewerSourceFor({}, { baseUrl: BASE, token: null })).toBeNull();
  });
});

describe("viewerFileName", () => {
  it("uses the title", () => {
    expect(viewerFileName({ title: "Payment proof", url: "x" }, 0)).toBe("Payment proof");
  });

  it("falls back to the caption, then to a position", () => {
    expect(viewerFileName({ caption: "Lunch", url: "x" }, 0)).toBe("Lunch");
    expect(viewerFileName({ url: "x" }, 2)).toBe("image-3");
  });

  it("ignores a blank title", () => {
    expect(viewerFileName({ title: "   ", url: "x" }, 0)).toBe("image-1");
  });
});

describe("the store", () => {
  it("starts closed", () => {
    expect(getAssetViewerState()).toBeNull();
  });

  it("opens on the tapped item and keeps the whole gallery", () => {
    openAssetViewer([{ url: "a" }, { url: "b" }, { url: "c" }], 1);

    expect(getAssetViewerState()).toEqual({
      index: 1,
      items: [{ url: "a" }, { url: "b" }, { url: "c" }],
    });
  });

  it("drops items with nothing to load", () => {
    openAssetViewer([{ url: "a" }, { caption: "no source" }, { assetId: "b" }]);

    expect(getAssetViewerState()?.items).toHaveLength(2);
  });

  it("does not open on an empty collection", () => {
    openAssetViewer([{ caption: "no source" }]);

    expect(getAssetViewerState()).toBeNull();
  });

  it("clamps the opening index against the filtered list", () => {
    openAssetViewer([{ url: "a" }, { caption: "dropped" }], 1);

    expect(getAssetViewerState()?.index).toBe(0);
  });

  it("notifies subscribers on open, page and close", () => {
    let notifications = 0;
    const unsubscribe = subscribeToAssetViewer(() => {
      notifications += 1;
    });

    openAssetViewer([{ url: "a" }, { url: "b" }]);
    setAssetViewerIndex(1);
    closeAssetViewer();
    unsubscribe();

    expect(notifications).toBe(3);
  });

  it("does not re-emit when the page has not moved", () => {
    openAssetViewer([{ url: "a" }, { url: "b" }], 1);
    const before = getAssetViewerState();

    setAssetViewerIndex(1);

    // Identity, not equality: a fresh object every scroll event is a render loop.
    expect(getAssetViewerState()).toBe(before);
  });

  it("ignores paging while closed", () => {
    setAssetViewerIndex(2);

    expect(getAssetViewerState()).toBeNull();
  });

  it("does not re-emit a close that has already happened", () => {
    let notifications = 0;
    const unsubscribe = subscribeToAssetViewer(() => {
      notifications += 1;
    });

    closeAssetViewer();
    unsubscribe();

    expect(notifications).toBe(0);
  });
});
