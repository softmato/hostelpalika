import { HostelBranchDetailPage } from "@/app/_components/hostel-branch-detail-page";
import { HostelBranchesPageContent } from "@/app/_components/hostel-branches-page";
import { branchesLock } from "@/lib/hostel-workspace";

export default async function Page({ params }: { params: Promise<{ branchId: string; hostelSlug: string }> }) {
  const { branchId, hostelSlug } = await params;
  const lock = await branchesLock(hostelSlug);

  return lock ? <HostelBranchesPageContent lock={lock} /> : <HostelBranchDetailPage branchId={branchId} />;
}
