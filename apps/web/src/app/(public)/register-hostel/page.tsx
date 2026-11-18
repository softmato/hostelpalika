import type { Metadata } from "next";

import { PublicHostelRegistrationLandingPage } from "@/app/_components/public-hostel-registration-landing-page";
import { staticPageMetadata } from "@/lib/seo-config";
import { loadSiteConfig } from "@/lib/site-config-server";

export function generateMetadata(): Promise<Metadata> {
  return staticPageMetadata("registerHostel");
}

export default async function RegisterHostelPage() {
  return <PublicHostelRegistrationLandingPage platformStats={(await loadSiteConfig()).platformStats} />;
}
