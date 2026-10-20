import type { NextRequest } from "next/server";

import { loadApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { connectToDatabase } from "@/lib/db";
import { listTrendingTags } from "@/modules/community/community.service";
import { listLiveSponsors } from "@/modules/sponsors/sponsor.service";
import { HostelModel } from "@hostel/db/models/Hostel";
import { RatingReviewModel } from "@hostel/db/models/RatingReview";
import type { Types } from "mongoose";

export const runtime = "nodejs";

type PopularHostelRecord = {
  _id: Types.ObjectId;
  name?: string;
  slug?: string;
};

/**
 * Everything the community's rails need that isn't the feed itself: paid
 * sponsor cards, trending tags, and a short popular-hostels list.
 *
 * One endpoint rather than three because they render together, above the fold,
 * on every visit — three round trips would show the rail assembling itself in
 * pieces. Public: a signed-out reader sees the same rails.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await loadApiPrincipal(request);
    const [sponsors, trendingTags, popularHostels] = await Promise.all([
      listLiveSponsors(),
      listTrendingTags(principal),
      loadPopularHostels(),
    ]);

    return withEtag(request, successResponse(
      { popularHostels, sponsors, trendingTags },
      "Community sidebar loaded",
    ));
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * Best-rated published hostels — the rail's "people are looking at these" list.
 *
 * Ratings live on `RatingReview`, not on the hostel, so this reads a shortlist
 * of published hostels and scores them in one aggregate rather than sorting on
 * a column that does not exist. An unrated hostel still qualifies; it simply
 * sorts below anything with reviews.
 */
async function loadPopularHostels() {
  await connectToDatabase();

  const hostels = await HostelModel.find({
    isDeleted: { $ne: true },
    status: "PUBLISHED",
  })
    .sort({ createdAt: -1 })
    .limit(25)
    .select("name slug")
    .lean<PopularHostelRecord[]>();

  if (hostels.length === 0) {
    return [];
  }

  const ratings = await RatingReviewModel.aggregate<{
    _id: Types.ObjectId;
    average: number;
  }>([
    {
      $match: {
        hostelId: { $in: hostels.map((hostel) => hostel._id) },
        status: "VISIBLE",
      },
    },
    { $group: { _id: "$hostelId", average: { $avg: "$overallRating" } } },
  ]);
  const averageById = new Map(
    ratings.map((row) => [row._id.toString(), row.average]),
  );

  return hostels
    .map((hostel) => {
      const average = averageById.get(hostel._id.toString());

      return {
        id: hostel._id.toString(),
        name: hostel.name ?? "Hostel",
        rating: average ? Number(average.toFixed(1)) : null,
        slug: hostel.slug ?? "",
      };
    })
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
    .slice(0, 4);
}
