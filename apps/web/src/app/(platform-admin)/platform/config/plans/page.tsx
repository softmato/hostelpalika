import { Suspense } from "react";

import { PlatformConfigPlansPageContent } from "@/app/_components/platform-config-plans-page";

export default function PlatformConfigPlansPage() {
  // The tab lives in `?tab=` (the search palette deep-links to fields), which needs a boundary to read.
  return (
    <Suspense>
      <PlatformConfigPlansPageContent />
    </Suspense>
  );
}
