import type { Metadata } from "next";

import { SavedHostelsPage } from "@/app/_components/saved-hostels-page";

export const metadata: Metadata = { robots: { follow: false, index: false }, title: "Saved hostels" };

export default function SavedPage() {
  return <SavedHostelsPage />;
}
