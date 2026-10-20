"use client";

import { memo } from "react";

import { CommunityModerationPanel } from "@/app/_components/community-moderation-panel";
import { PortalPageHeader } from "@/app/_components/portal-dashboard-ui";

/**
 * Platform-wide community moderation. The only surface that can reach a
 * public-space post: those belong to no hostel, so no hostel admin has scope
 * over them.
 */
export const PlatformCommunityPageContent = memo(function PlatformCommunityPageContent() {
  return (
    <div className="mx-auto max-w-[1448px] space-y-5">
      <PortalPageHeader
        description="Reported posts from every community space."
        title="Community Reports"
      />
      <CommunityModerationPanel endpoint="/api/v1/platform/community" tone="platform" />
    </div>
  );
});
