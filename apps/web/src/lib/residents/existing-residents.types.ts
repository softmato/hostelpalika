export type ListRow = {
  depositPaid: number;
  email: string;
  fullName: string;
  id: string;
  /** ISO string, or null. */
  joinedDate: string | null;
  monthlyRent: number | null;
  oldDues: number;
  paidTill: string | null;
  /** Rent already paid towards the oldest month due. */
  partPaid: number;
  phone: string;
  /** Set once this row has been added as a resident. */
  residentId: string | null;
  /** `101` — their numbered room, when the hostel keeps floors and rooms. */
  roomNumber: string;
  roomType: string;
};

export type RowField =
  | "email"
  | "fullName"
  | "joinedDate"
  | "monthlyRent"
  | "paidTill"
  | "partPaid"
  | "phone"
  | "roomNumber"
  | "roomType";

export type RowProblem = { field: RowField; message: string };

export type BillPreview = {
  /** Rent months that will be billed when the list is added, oldest first. */
  months: { amount: number; label: string; period: string }[];
  oldDues: number;
  /** Comes off the first month in `months`. */
  partPaid: number;
  total: number;
};

export type CheckedRow = {
  /** Null until the row has what it needs to be priced. */
  bills: BillPreview | null;
  id: string;
  added: boolean;
  problems: RowProblem[];
  /** The rent this resident will pay each month from here on. */
  rent: number | null;
};

export type RoomTypeSummary = {
  freeBeds: number;
  inList: number;
  roomType: string;
};

export type CheckResult = {
  /** Problems about the whole list rather than one line. */
  listProblems: string[];
  ready: boolean;
  roomTypes: RoomTypeSummary[];
  rows: CheckedRow[];
  toAdd: number;
  withProblems: number;
};

export type AddResult = {
  added: number;
  billsRaised: number;
  problems: { message: string; name: string }[];
};

export type ExistingResidentsView = {
  check: CheckResult | null;
  currentMonth: { label: string; period: string };
  hostel: { id: string; name: string };
  /** What the last "Add all" did, for the screen to say so. */
  lastAdded: (AddResult & { addedAt: string }) | null;
  list: { id: string; rows: ListRow[]; updatedAt: string | null } | null;
  /** The rooms a line can be put in — null when the hostel keeps room types only. */
  numberedRooms: NumberedRoom[] | null;
  roomTypes: { freeBeds: number; monthlyRent: number | null; roomType: string }[];
};

/** A numbered room and its free beds right now (`HostelRoom`). */
export type NumberedRoom = { beds: number; floor: number; free: number; id: string; number: string; roomType: string };
