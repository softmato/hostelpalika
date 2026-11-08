import "server-only";

import { FileAssetModel } from "@hostel/db/models/FileAsset";

import { connectToDatabase } from "@/lib/db";

/**
 * Photo addresses a search engine can use.
 *
 * Hostel photos are stored as `/api/v1/files/<id>/url` on purpose: the profile
 * page notes that an origin baked into a stored URL follows the photo forever.
 * A browser resolves that path against the site and follows its redirect to the
 * media host. A search engine cannot use it. A sitemap `<image:loc>` must be an
 * absolute URL — Search Console reported every one as "Invalid URL" — and
 * `/api/` is closed in robots.txt, so even an absolute copy of the path could
 * not be fetched.
 *
 * So for search, and only for search, a photo resolves to its asset's public
 * media URL — the address the route itself would redirect to. That happens only
 * for an asset that is PUBLIC, ACTIVE and not deleted, which gallery photos are;
 * anything else is left out rather than exposed. Absolute URLs already on the
 * media host pass through unchanged.
 */

const FILE_ROUTE = /^\/api\/v1\/files\/([a-f0-9]{24})\/url(?:\?.*)?$/i;

/** The asset id inside a stored `/api/v1/files/<id>/url` photo path, if it is one. */
export function photoAssetId(url: string) {
  return FILE_ROUTE.exec(url.trim())?.[1] ?? null;
}

type PublicAsset = {
  _id: { toString(): string };
  key: string;
  variants?: Array<{ key: string; variant: string }>;
};

/**
 * Maps each input URL to an absolute, crawlable image URL. URLs that cannot be
 * resolved to a public image are absent from the map.
 */
export async function resolveSearchImageUrls(urls: string[]): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  const byAssetId = new Map<string, string[]>();

  for (const url of new Set(urls.filter(Boolean))) {
    if (/^https:\/\//i.test(url)) {
      resolved.set(url, url);
      continue;
    }

    const assetId = photoAssetId(url);
    if (assetId) {
      byAssetId.set(assetId, [...(byAssetId.get(assetId) ?? []), url]);
    }
  }

  const publicBase = process.env.R2_PUBLIC_URL?.replace(/\/+$/, "");

  if (byAssetId.size === 0 || !publicBase) {
    return resolved;
  }

  await connectToDatabase();

  const assets = await FileAssetModel.find({
    _id: { $in: [...byAssetId.keys()] },
    accessLevel: "PUBLIC",
    isDeleted: false,
    status: "ACTIVE",
  })
    .select("key variants")
    .lean<PublicAsset[]>();

  for (const asset of assets) {
    // The large rendition when there is one: sharp enough for image search and
    // a link preview, without sending crawlers a phone camera's original.
    const key = asset.variants?.find((variant) => variant.variant === "LARGE")?.key ?? asset.key;
    const absolute = `${publicBase}/${key.replace(/^\/+/, "")}`;

    for (const url of byAssetId.get(asset._id.toString()) ?? []) {
      resolved.set(url, absolute);
    }
  }

  return resolved;
}

/** The same, for one list: resolvable photos in order, the rest dropped. */
export async function searchImageUrls(urls: string[]) {
  const resolved = await resolveSearchImageUrls(urls);

  return urls.map((url) => resolved.get(url)).filter((url): url is string => Boolean(url));
}
