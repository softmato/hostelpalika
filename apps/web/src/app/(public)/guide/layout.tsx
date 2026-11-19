import type { ReactNode } from "react";

import { GuideShell } from "@/app/_components/guide/guide-shell";
import { guideNav, guideSearchIndex, loadGuide } from "@/lib/guide-access";

/** Asks the API as this reader, so every guide page renders per reader (never one copy for all). */
export default async function GuideLayout({ children }: { children: ReactNode }) {
  const payload = await loadGuide();
  return (
    <GuideShell nav={payload ? guideNav(payload) : []} search={payload ? guideSearchIndex(payload) : []}>
      {children}
    </GuideShell>
  );
}
