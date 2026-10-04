import type { Metadata } from "next";

import { HostelPaymentCredentialsReminder } from "@/app/_components/hostel-payment-credentials-reminder";
import { HostelSubscriptionDueBanner } from "@/app/_components/hostel-subscription-due-banner";
import { PortalShell } from "@/components/portal-shell";
import { HOSTEL_ADMIN_NAV, HOSTEL_ADMIN_SEARCH_ENTRIES } from "@/lib/portal-nav";
import { PORTAL_ROBOTS } from "@/lib/seo";

/** Signed-in workspace: kept out of search, links included (robots.txt disallows it too). */
export const metadata: Metadata = { robots: PORTAL_ROBOTS };

export default function HostelAdminLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <PortalShell
      navGroups={HOSTEL_ADMIN_NAV}
      searchEntries={HOSTEL_ADMIN_SEARCH_ENTRIES}
      searchPlaceholder="Search residents, rooms, payments..."
      subtitle="Hostel Admin Portal"
      tone="admin"
      workspaceName="Hostel Workspace"
    >
      <HostelSubscriptionDueBanner />
      <div className="sticky -top-4 z-20 -mt-4 mb-4 flex flex-col gap-2 bg-background pt-4 empty:hidden">
        <HostelPaymentCredentialsReminder paymentProfileHref="/hostel-admin/payment-setup" />
      </div>
      {children}
    </PortalShell>
  );
}
