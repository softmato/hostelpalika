import { hostelStaffJoin } from "@/modules/residents/existing-residents.routes";

export const runtime = "nodejs";
// Add bills every unpaid month for the one person, same as the scan desk.
export const maxDuration = 300;

export const { POST } = hostelStaffJoin.one;
