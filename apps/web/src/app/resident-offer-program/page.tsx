import type { Metadata } from "next";

import { PublicOfferProgramPage } from "@/app/_components/public-offer-program-page";
import { staticPageMetadata } from "@/lib/seo-config";

/**
 * `/resident-offer-program` — its own route, outside the `(public)` group.
 *
 * Standalone because it is not part of the marketing site: it is the page a
 * payment email points a resident at, and the one link a guardian who has no
 * account can be sent. The site configuration it reads comes from the root
 * layout, so it renders correctly without the public group's wrapper.
 *
 * UI follows the legal pages (privacy, terms) for now — plain sections of plain
 * answers, which is what this content is. A fuller treatment is later work.
 */
export const revalidate = 21600;

export function generateMetadata(): Promise<Metadata> {
  return staticPageMetadata("offerProgram");
}

export default function ResidentOfferProgramPage() {
  return <PublicOfferProgramPage />;
}
