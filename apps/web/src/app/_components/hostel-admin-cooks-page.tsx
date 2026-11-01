"use client";

import { ChefHat } from "@/components/icons";

import { PageHeader } from "./core-portal-shared";
import { HostelAdminCooksPanel } from "./hostel-admin-cooks-panel";

/** The kitchen roster on its own page, beside Wardens and Residents under Users. */
export function HostelAdminCooksPage() {
  return (
    <div className="mx-auto max-w-[1448px] space-y-5">
      <PageHeader
        description="The cooks who post that a meal is ready, and what they may do."
        icon={ChefHat}
        title="Cooks"
      />
      <HostelAdminCooksPanel />
    </div>
  );
}
