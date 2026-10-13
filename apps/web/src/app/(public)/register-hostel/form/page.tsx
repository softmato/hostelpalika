import type { Metadata } from "next";

import { QuickHostelRegistrationForm } from "@/app/_components/quick-hostel-registration-form";
import { AuthGuard } from "@/components/auth-guard";
import { NOINDEX } from "@/lib/seo";

export const metadata: Metadata = {
  // A signed-in form step; /register-hostel is the page search should show.
  robots: NOINDEX,
  title: "Register your hostel",
};

export default function RegisterHostelFormPage() {
  return (
    <AuthGuard>
      <QuickHostelRegistrationForm />
    </AuthGuard>
  );
}
