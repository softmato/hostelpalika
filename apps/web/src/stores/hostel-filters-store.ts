import { create } from "zustand";

/**
 * Client UI state for the public hostel listing filters (Zustand — client state
 * layer per ARCHITECTURE.md). Kept separate from server state (TanStack Query).
 */
export type HostelFiltersState = {
  area: string;
  budget: string;
  college: string;
  /**
   * Dietary preference — "Any" | "Veg" | "Non-veg". Distinct from `food`, which
   * asks whether meals are provided at all; this asks what is on the plate and
   * is the one the API filters on server-side.
   */
  diet: string;
  facilities: string[];
  food: string;
  query: string;
  room: string;
  sortBy: string;
  /** "Any" | "Short stays" — the latter only lists hostels taking nightly stays. */
  stay: string;
  type: string;
  viewMode: "grid" | "list";
};

export const initialHostelFilters: HostelFiltersState = {
  area: "All Areas",
  budget: "Any Budget",
  college: "All Colleges",
  diet: "Any",
  facilities: [],
  food: "Any",
  query: "",
  room: "All Room Types",
  sortBy: "Recommended",
  stay: "Any",
  type: "All Types",
  viewMode: "grid",
};

type HostelFiltersStore = HostelFiltersState & {
  reset: () => void;
  update: (patch: Partial<HostelFiltersState>) => void;
};

export const useHostelFiltersStore = create<HostelFiltersStore>((set) => ({
  ...initialHostelFilters,
  reset: () => set(initialHostelFilters),
  update: (patch) => set(patch),
}));
