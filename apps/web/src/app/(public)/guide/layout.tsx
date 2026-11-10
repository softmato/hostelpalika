import type { ReactNode } from "react";

import { GuideShell } from "@/app/_components/guide/guide-shell";

export default function GuideLayout({ children }: { children: ReactNode }) {
  return <GuideShell>{children}</GuideShell>;
}
