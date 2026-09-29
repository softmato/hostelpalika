import { hostelStaffExistingResidents } from "@/modules/residents/existing-residents.routes";

export const runtime = "nodejs";
// Bills every unpaid month for the one person, same as "Add all".
export const maxDuration = 300;

export const { POST } = hostelStaffExistingResidents.one;
