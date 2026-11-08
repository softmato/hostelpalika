export type TeamOwnerEmailStatus = "AVAILABLE" | "EXISTING_ACCOUNT" | "HOSTEL" | "OTHER_ROLE";

/** `GET /api/v1/hostel-admin/branches/:branchId` (`getBranchDetails`). */
export type BranchDetails = {
  documents: Array<{ id: string; rejectionReason: string; status: string; type: string }>;
  hostel: {
    capacitySummary: { totalBeds?: number; totalRooms?: number; vacantBeds?: number };
    contact: { alternatePhone?: string; email?: string; phone?: string };
    description: string;
    facilities: string[];
    food: { hasNonVeg?: boolean; hasVeg?: boolean; mealsPerDay?: number; notes?: string };
    hostelType: string;
    id: string;
    location: { address?: string; area?: string; city?: string; landmark?: string; mapLink?: string; province?: string };
    name: string;
    panNumber: string | null;
    parentHostelId: string | null;
    photos: Array<{ alt: string; fileAssetId?: string; id?: string; kind: string; mediumUrl: string; roomType: string; url: string }>;
    pricing: { admissionFee?: number; formFee?: number };
    roomConfigurations: Array<{
      bedsPerRoom?: number;
      mealInclusion?: string;
      monthlyRent?: number;
      roomType: string;
      rooms?: number;
      securityDeposit?: number;
      vacantBeds?: number;
    }>;
    rules: string[];
    securityDeposit?: number;
    shortStays?: { enabled?: boolean; minNights?: number; rates?: Array<{ dailyRate: number; roomType: string }> };
    slug: string;
    status: string;
    totalFloors: number;
    verificationStatus?: string;
    yearEstablished: string;
  };
  main: { id: string; name: string; slug: string };
};
