import type { Metadata } from "next";

import { QuickHostelRegistrationForm } from "@/app/_components/quick-hostel-registration-form";
import { AuthGuard } from "@/components/auth-guard";
import { NOINDEX } from "@/lib/seo";

export const metadata: Metadata = {
  // The same form as /register-hostel/form, kept for old links.
  robots: NOINDEX,
  title: "Register your hostel",
};

export default function HostelRegistrationPage() {
  return (
    <AuthGuard>
      <QuickHostelRegistrationForm />
    </AuthGuard>
  );
}
