import { formatHostelDate } from "@hostel/shared/calendar/bs";
/**
 * The shapes `/api/v1/platform/team` hands back, kept in one place because the
 * Team tab is three components deep and passing these down as inline types
 * meant editing the same object literal in three files.
 */

export type TeamMember = {
  cashCollected: number;
  /**
   * Whether the account can be destroyed outright rather than merely removed.
   * Decided by the server — see `listTeamRoster` — so the row offers the action
   * that will actually succeed instead of one that answers 409.
   */
  deletable: boolean;
  email: string;
  hostelsRegistered: number;
  id: string;
  joinedAt: string | null;
  lastLoginAt: string | null;
  name: string;
  phone: string;
  /** The role removal hands back, or null when the team was all they were. */
  previousRole: string | null;
  status: string;
};

export type TeamInvite = {
  email: string;
  expired: boolean;
  expiresAt: string;
  id: string;
  invitedAt: string | null;
  name: string;
};

export type TeamRegistration = {
  agentEmail: string;
  agentName: string;
  cashCollected: number;
  dueBy: string | null;
  hostelId: string;
  hostelName: string;
  hostelStatus: string;
  invoiceNumber: string;
  onlineCollected: number;
  outstanding: number;
  paid: number;
  planName: string;
  price: number;
  registeredAt: string | null;
  subscriptionStatus: string;
};

export type TeamInviteResult = {
  delivered: boolean;
  email: string;
  error: string | null;
  sent: boolean;
};

export function rupees(amount: number) {
  return `Rs ${amount.toLocaleString("en-IN")}`;
}

export function shortDate(iso: string | null) {
  if (!iso) {
    return "—";
  }

  return formatHostelDate(iso);
}

/** How a displaced role reads on a roster row, for the people who have one. */
export const ROLE_LABELS: Record<string, string> = {
  COOK: "cook",
  GUARDIAN: "guardian",
  HOSTEL_ADMIN: "hostel admin",
  PUBLIC: "public account",
  RESIDENT: "resident",
  WARDEN: "warden",
};
