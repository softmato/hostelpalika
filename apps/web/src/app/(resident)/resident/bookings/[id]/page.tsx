import { ResidentBookingDetailPageContent } from "@/app/_components/my-bookings-page";

type PageProps = { params: Promise<{ id: string }> };

export default async function ResidentBookingPage({ params }: PageProps) {
  const { id } = await params;

  return <ResidentBookingDetailPageContent bookingId={id} />;
}
