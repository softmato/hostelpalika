import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  addEmergencyContact: vi.fn(),
  addGuardian: vi.fn(),
  createResident: vi.fn(),
  getResidentById: vi.fn(),
  listResidents: vi.fn(),
  requireHostelCapability: vi.fn(),
  requireHostelStaffPrincipal: vi.fn(),
  updateResident: vi.fn(),
  updateResidentStatus: vi.fn(),
}));

vi.mock("@/lib/api-auth", () => ({
  requireHostelCapability: routeMocks.requireHostelCapability,
  requireHostelStaffPrincipal: routeMocks.requireHostelStaffPrincipal,
}));

vi.mock("@/modules/residents/resident.service", () => ({
  addEmergencyContact: routeMocks.addEmergencyContact,
  addGuardian: routeMocks.addGuardian,
  createResident: routeMocks.createResident,
  getResidentById: routeMocks.getResidentById,
  listResidents: routeMocks.listResidents,
  updateResident: routeMocks.updateResident,
  updateResidentStatus: routeMocks.updateResidentStatus,
}));

import * as residentEmergencyContactsRoute from "@/app/api/v1/hostel-admin/residents/[id]/emergency-contacts/route";
import * as residentGuardiansRoute from "@/app/api/v1/hostel-admin/residents/[id]/guardians/route";
import * as residentStatusRoute from "@/app/api/v1/hostel-admin/residents/[id]/status/route";
import * as residentDetailRoute from "@/app/api/v1/hostel-admin/residents/[id]/route";
import * as residentsRoute from "@/app/api/v1/hostel-admin/residents/route";
import { Role } from "@/lib/roles";

const staffPrincipal = {
  hostelIds: ["64f0f0f0f0f0f0f0f0f0f0f4"],
  role: Role.HOSTEL_ADMIN,
  sessionId: "session-1",
  userId: "64f0f0f0f0f0f0f0f0f0f0f5",
};

function jsonRequest(path: string, body: unknown) {
  return new NextRequest(`https://hostelpalika.local${path}`, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
    },
    method: "POST",
  });
}

function getRequest(path: string) {
  return new NextRequest(`https://hostelpalika.local${path}`, {
    method: "GET",
  });
}

function patchRequest(path: string, body: unknown) {
  return new NextRequest(`https://hostelpalika.local${path}`, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
    },
    method: "PATCH",
  });
}

function routeContext<T extends Record<string, string>>(params: T) {
  return {
    params: Promise.resolve(params),
  };
}

describe("resident management routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeMocks.requireHostelStaffPrincipal.mockResolvedValue(staffPrincipal);
    routeMocks.requireHostelCapability.mockResolvedValue(staffPrincipal);
  });

  it("creates residents through the hostel-admin route, admitted by default", async () => {
    // The portal's form sends no status, and the resident it registers has to
    // come out billable. Defaulting to `PENDING` gave a row that read
    // "Not billed" on the Payments tab for ever, because nothing bills a
    // resident who was never admitted.
    routeMocks.createResident.mockResolvedValue({
      resident: { id: "resident-1", status: "ACTIVE" },
    });

    const response = await residentsRoute.POST(
      jsonRequest("/api/v1/hostel-admin/residents", {
        firstName: "Asha",
        lastName: "Rai",
        moveInDate: "2030-01-01",
        phone: "9800000000",
        roomType: "Four Sharing",
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(payload.data.resident.status).toBe("ACTIVE");
    expect(routeMocks.createResident).toHaveBeenCalledWith(
      expect.objectContaining({
        firstName: "Asha",
        moveInDate: expect.any(Date),
        status: "ACTIVE",
      }),
      staffPrincipal,
    );
  });

  it("lists residents with hostel and status filters", async () => {
    routeMocks.listResidents.mockResolvedValue({
      residents: [{ id: "resident-1", status: "ACTIVE" }],
    });

    const response = await residentsRoute.GET(
      getRequest(
        "/api/v1/hostel-admin/residents?hostelId=64f0f0f0f0f0f0f0f0f0f0f4&status=ACTIVE&q=asha",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.data.residents).toHaveLength(1);
    expect(routeMocks.listResidents).toHaveBeenCalledWith(
      {
        hostelId: "64f0f0f0f0f0f0f0f0f0f0f4",
        q: "asha",
        status: "ACTIVE",
      },
      staffPrincipal,
    );
  });

  it("loads and updates resident detail", async () => {
    routeMocks.getResidentById.mockResolvedValue({
      resident: { id: "64f0f0f0f0f0f0f0f0f0f0f8", firstName: "Asha" },
    });
    routeMocks.updateResident.mockResolvedValue({
      resident: { id: "64f0f0f0f0f0f0f0f0f0f0f8", firstName: "Asmita" },
    });

    const getResponse = await residentDetailRoute.GET(
      getRequest("/api/v1/hostel-admin/residents/64f0f0f0f0f0f0f0f0f0f0f8"),
      routeContext({ id: "64f0f0f0f0f0f0f0f0f0f0f8" }),
    );
    const patchResponse = await residentDetailRoute.PATCH(
      patchRequest("/api/v1/hostel-admin/residents/64f0f0f0f0f0f0f0f0f0f0f8", {
        firstName: "Asmita",
      }),
      routeContext({ id: "64f0f0f0f0f0f0f0f0f0f0f8" }),
    );

    expect(getResponse.status).toBe(200);
    expect(patchResponse.status).toBe(200);
    expect(routeMocks.getResidentById).toHaveBeenCalledWith(
      "64f0f0f0f0f0f0f0f0f0f0f8",
      {},
      staffPrincipal,
    );
    expect(routeMocks.updateResident).toHaveBeenCalledWith(
      "64f0f0f0f0f0f0f0f0f0f0f8",
      { firstName: "Asmita" },
      staffPrincipal,
    );
  });

  it("updates resident status and adds contacts", async () => {
    routeMocks.updateResidentStatus.mockResolvedValue({
      resident: { id: "resident-1", status: "SUSPENDED" },
    });
    routeMocks.addGuardian.mockResolvedValue({
      guardian: { id: "guardian-1", phone: "9811111111" },
    });
    routeMocks.addEmergencyContact.mockResolvedValue({
      emergencyContact: { id: "contact-1", phone: "9822222222" },
    });

    const statusResponse = await residentStatusRoute.PATCH(
      patchRequest("/api/v1/hostel-admin/residents/64f0f0f0f0f0f0f0f0f0f0f8/status", {
        status: "SUSPENDED",
      }),
      routeContext({ id: "64f0f0f0f0f0f0f0f0f0f0f8" }),
    );
    const guardianResponse = await residentGuardiansRoute.POST(
      jsonRequest("/api/v1/hostel-admin/residents/64f0f0f0f0f0f0f0f0f0f0f8/guardians", {
        firstName: "Maya",
        lastName: "Rai",
        phone: "9811111111",
        relation: "Mother",
      }),
      routeContext({ id: "64f0f0f0f0f0f0f0f0f0f0f8" }),
    );
    const emergencyResponse = await residentEmergencyContactsRoute.POST(
      jsonRequest(
        "/api/v1/hostel-admin/residents/64f0f0f0f0f0f0f0f0f0f0f8/emergency-contacts",
        {
          name: "Kiran Rai",
          phone: "9822222222",
          relation: "Uncle",
        },
      ),
      routeContext({ id: "64f0f0f0f0f0f0f0f0f0f0f8" }),
    );

    expect(statusResponse.status).toBe(200);
    expect(guardianResponse.status).toBe(201);
    expect(emergencyResponse.status).toBe(201);
    expect(routeMocks.updateResidentStatus).toHaveBeenCalledWith(
      "64f0f0f0f0f0f0f0f0f0f0f8",
      { status: "SUSPENDED" },
      staffPrincipal,
    );
    expect(routeMocks.addGuardian).toHaveBeenCalledWith(
      "64f0f0f0f0f0f0f0f0f0f0f8",
      expect.objectContaining({ isPrimary: false, relation: "Mother" }),
      staffPrincipal,
    );
    expect(routeMocks.addEmergencyContact).toHaveBeenCalledWith(
      "64f0f0f0f0f0f0f0f0f0f0f8",
      expect.objectContaining({ isPrimary: false, relation: "Uncle" }),
      staffPrincipal,
    );
  });

  it("rejects invalid resident payloads before calling the service", async () => {
    const response = await residentsRoute.POST(
      jsonRequest("/api/v1/hostel-admin/residents", {
        firstName: "",
        moveInDate: "not-a-date",
        phone: "1",
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(422);
    expect(payload.errorCode).toBe("VALIDATION_ERROR");
    expect(routeMocks.createResident).not.toHaveBeenCalled();
  });
});
