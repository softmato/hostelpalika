import type { Metadata } from "next";

import { ResidentJoinPage } from "@/app/_components/resident-join-page";
import { NOINDEX } from "@/lib/seo";

export const metadata: Metadata = {
  // A hostel's private join link: never a search result.
  robots: NOINDEX,
  title: "Join your hostel",
};

export default async function JoinPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  return <ResidentJoinPage token={token} />;
}
