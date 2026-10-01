import { hostelStaffJoin } from "@/modules/residents/existing-residents.routes";

export const runtime = "nodejs";

export const { GET, PATCH } = hostelStaffJoin.link;
