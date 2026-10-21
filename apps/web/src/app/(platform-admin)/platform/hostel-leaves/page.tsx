import { Suspense } from "react";

import { PlatformHostelLeavesPageContent } from "@/app/_components/platform-hostel-leaves-page";

export default function PlatformHostelLeavesPage() {
  // `useSearchParams` (the bell's `?request=` deep link) needs a boundary.
  return (
    <Suspense>
      <PlatformHostelLeavesPageContent />
    </Suspense>
  );
}
