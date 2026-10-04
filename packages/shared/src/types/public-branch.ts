/** Public discovery data only; never includes owner identity or KYC documents. */
export type PublicBranch = {
  id: string;
  slug: string;
  name: string;
  area: string;
  city: string;
  photoUrl: string | null;
};
