import type { Metadata } from "next";

import { AdmissionFormPage } from "@/app/_components/admission-form-page";
import { NOINDEX } from "@/lib/seo";

export const metadata: Metadata = {
  // A hostel's private Form QR: never a search result.
  robots: NOINDEX,
  title: "Admission form",
};

export default async function ApplyPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  return <AdmissionFormPage token={token} />;
}
