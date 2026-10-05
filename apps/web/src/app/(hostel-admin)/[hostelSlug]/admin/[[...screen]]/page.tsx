import { notFound, redirect } from "next/navigation";

import { HOSTEL_ADMIN_SCREENS } from "@/app/_components/hostel-admin-screens";
import { HostelAdminOverallPage, OVERALL_SCREENS } from "@/app/_components/hostel-admin-overall-page";
import { OVERALL_SLUG } from "@/lib/branch-cache";

type HostelAdminWorkspacePageProps = {
  params: Promise<{ hostelSlug: string; screen?: string[] }>;
};

export default async function HostelAdminWorkspacePage({
  params,
}: HostelAdminWorkspacePageProps) {
  const { hostelSlug, screen } = await params;

  if (!screen || screen.length === 0) {
    redirect(`/${hostelSlug}/admin/dashboard`);
  }

  if (screen.length > 1) {
    notFound();
  }

  // The layout has already refused anyone but an owner of several hostels.
  if (hostelSlug === OVERALL_SLUG) {
    const overallScreen = OVERALL_SCREENS.find((entry) => entry === screen[0]);

    if (!overallScreen) notFound();

    return <HostelAdminOverallPage screen={overallScreen} />;
  }

  const render = HOSTEL_ADMIN_SCREENS[screen[0]];

  if (!render) {
    notFound();
  }

  return render(hostelSlug);
}
