import type { Metadata } from "next";

import { PLATFORM_NAME } from "@hostel/shared/brand/brand";

import { CommunityPageContent } from "@/app/_components/community-page";
import { NOINDEX, pageMetadata, snippet } from "@/lib/seo";
import { getCommunityPost } from "@/modules/community/community.service";

type PageParams = {
  params: Promise<{ postId: string }>;
};

/**
 * A public post can answer somebody's search ("girls hostel near Putalisadak
 * with food?"), so its words become the title and description. A post too short
 * to answer anything — "hi", a photo with no caption — stays out of the index,
 * and a hostel-only or removed post answers as not found.
 */
export async function generateMetadata({ params }: PageParams): Promise<Metadata> {
  const { postId } = await params;

  try {
    const { post } = await getCommunityPost(postId, null);
    const body = (post.body ?? "").replace(/\s+/g, " ").trim();

    return pageMetadata({
      description: body
        ? snippet(body, 158)
        : `A post from the ${PLATFORM_NAME} hostel community in Nepal.`,
      eyebrow: "Community",
      noindex: body.length < 80,
      path: `/community/${postId}`,
      title: body ? snippet(body, 60) : "Community post",
    });
  } catch {
    return { robots: NOINDEX, title: "Community post" };
  }
}

/** Permalink for a single post — what the share button hands out. */
export default async function CommunityPostPage({ params }: PageParams) {
  const { postId } = await params;

  return <CommunityPageContent initialPostId={postId} />;
}
