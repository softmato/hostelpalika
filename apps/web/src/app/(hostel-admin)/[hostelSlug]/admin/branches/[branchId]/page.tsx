import { HostelBranchDetailPage } from "@/app/_components/hostel-branch-detail-page";
export default async function Page({ params }: { params: Promise<{ branchId: string }> }) {
  const { branchId } = await params;
  return <HostelBranchDetailPage branchId={branchId} />;
}
