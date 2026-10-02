"use client";

import { memo } from "react";

import { PortalPageHeader } from "@/app/_components/portal-dashboard-ui";
import { TemporaryCredentialsPanel } from "@/app/_components/temporary-credentials-panel";

/**
 * The resident portal's account-settings screen.
 *
 * It starts life holding one thing — temporary access logins — rather than
 * being folded into My Profile, because that page is the resident's *record*
 * (room, guardians, hostel contacts) and this is a control over the account
 * itself. Further account controls belong here as they arrive.
 */
export const ResidentSettingsPageContent = memo(function ResidentSettingsPageContent() {
  return (
    <div className="mx-auto max-w-[1100px] space-y-5">
      <PortalPageHeader
        breadcrumb={[{ href: "/resident/dashboard", label: "Home" }, "Settings"]}
        description="Account access controls for your resident login."
        title="Settings"
      />
      <TemporaryCredentialsPanel tone="resident" />
    </div>
  );
});
