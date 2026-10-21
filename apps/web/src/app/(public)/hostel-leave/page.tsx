import type { Metadata } from "next";

import { PublicHostelLeavePage } from "@/app/_components/public-hostel-leave-page";

export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Claim your hostel back",
};

export default function HostelLeavePage() {
  return <PublicHostelLeavePage />;
}
