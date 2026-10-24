export type Tone =
  | "admin"
  | "danger"
  | "guardian"
  | "platform"
  | "resident"
  | "slate"
  | "success"
  | "teal"
  | "warning";

export type HostelSummary = {
  address: string;
  area: string;
  city: string;
  description: string;
  facilities: string[];
  foodScore: number;
  id: string;
  image: string;
  /** Sample listing from demo-hostels.json — always sorted after real ones. */
  isDemoData?: boolean;
  name: string;
  owner: string;
  price: number;
  rating: number;
  reviews: number;
  roomTypes: string[];
  slug: string;
  status: "approved" | "pending" | "published" | "under review";
  type: "boys" | "co-living" | "girls";
  vacancy: number;
  verified: boolean;
};
