import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  confirmComplaintResolution: vi.fn(),
  createComplaint: vi.fn(),
  createMoveInChecklist: vi.fn(),
  createMoveOutChecklist: vi.fn(),
  createResidentReview: vi.fn(),
  getGuardianDashboard: vi.fn(),
  getGuardianSafetySummary: vi.fn(),
  getMoveInChecklist: vi.fn(),
  getMoveOutChecklist: vi.fn(),
  getResidentNightStatus: vi.fn(),
  hideReview: vi.fn(),
  listAdminComplaints: vi.fn(),
  listAdminNightStatus: vi.fn(),
  listAdminSOSAlerts: vi.fn(),
  listGuardianFood: vi.fn(),
  listGuardianNotices: vi.fn(),
  listGuardianPayments: vi.fn(),
  listNotifications: vi.fn(),
  listPlatformReviews: vi.fn(),
  listPublicHostelReviews: vi.fn(),
  listResidentComplaints: vi.fn(),
  listResidentEmergencyContacts: vi.fn(),
  markNotificationRead: vi.fn(),
  overrideNightStatus: vi.fn(),
  replyToComplaint: vi.fn(),
  requireApiPrincipal: vi.fn(),
  requireGuardianPrincipal: vi.fn(),
  requireHostelCapability: vi.fn(),
  requireHostelStaffPrincipal: vi.fn(),
  requirePlatformPrincipal: vi.fn(),
  requireResidentPrincipal: vi.fn(),
  saveDeviceToken: vi.fn(),
  triggerSOS: vi.fn(),
  unhideReview: vi.fn(),
  updateComplaintStatus: vi.fn(),
  updateResidentNightStatus: vi.fn(),
  updateSOSAlertStatus: vi.fn(),
}));

vi.mock("@/lib/api-auth", () => ({
  requireApiPrincipal: routeMocks.requireApiPrincipal,
  requireGuardianPrincipal: routeMocks.requireGuardianPrincipal,
  requireHostelCapability: routeMocks.requireHostelCapability,
  requireHostelStaffPrincipal: routeMocks.requireHostelStaffPrincipal,
  requirePlatformPrincipal: routeMocks.requirePlatformPrincipal,
  requireResidentPrincipal: routeMocks.requireResidentPrincipal,
}));

vi.mock("@/modules/complaints/complaint.service", () => ({
  confirmComplaintResolution: routeMocks.confirmComplaintResolution,
  createComplaint: routeMocks.createComplaint,
  listAdminComplaints: routeMocks.listAdminComplaints,
  listResidentComplaints: routeMocks.listResidentComplaints,
  replyToComplaint: routeMocks.replyToComplaint,
  updateComplaintStatus: routeMocks.updateComplaintStatus,
}));

vi.mock("@/modules/safety/safety.service", () => ({
  getResidentNightStatus: routeMocks.getResidentNightStatus,
  listAdminNightStatus: routeMocks.listAdminNightStatus,
  listAdminSOSAlerts: routeMocks.listAdminSOSAlerts,
  listResidentEmergencyContacts: routeMocks.listResidentEmergencyContacts,
  overrideNightStatus: routeMocks.overrideNightStatus,
  triggerSOS: routeMocks.triggerSOS,
  updateResidentNightStatus: routeMocks.updateResidentNightStatus,
  updateSOSAlertStatus: routeMocks.updateSOSAlertStatus,
}));

vi.mock("@/modules/guardian/guardian.service", () => ({
  getGuardianDashboard: routeMocks.getGuardianDashboard,
  getGuardianSafetySummary: routeMocks.getGuardianSafetySummary,
  listGuardianFood: routeMocks.listGuardianFood,
  listGuardianNotices: routeMocks.listGuardianNotices,
  listGuardianPayments: routeMocks.listGuardianPayments,
}));

vi.mock("@/modules/move-checklist/move-checklist.service", () => ({
  createMoveInChecklist: routeMocks.createMoveInChecklist,
  createMoveOutChecklist: routeMocks.createMoveOutChecklist,
  getMoveInChecklist: routeMocks.getMoveInChecklist,
  getMoveOutChecklist: routeMocks.getMoveOutChecklist,
}));

vi.mock("@/modules/reviews/review.service", () => ({
  createResidentReview: routeMocks.createResidentReview,
  hideReview: routeMocks.hideReview,
  listPlatformReviews: routeMocks.listPlatformReviews,
  listPublicHostelReviews: routeMocks.listPublicHostelReviews,
  unhideReview: routeMocks.unhideReview,
}));

vi.mock("@/modules/notifications/notification.service", () => ({
  listNotifications: routeMocks.listNotifications,
  markNotificationRead: routeMocks.markNotificationRead,
  saveDeviceToken: routeMocks.saveDeviceToken,
}));

// The guardian sign-in counts failed codes in Mongo.
vi.mock("@/lib/db", () => ({ connectToDatabase: vi.fn() }));

vi.mock("@hostel/db/models/AuthAttempt", async () => {
  const { fakeModel } = await import("../../../../test/fake-mongo");

  return { AuthAttemptModel: fakeModel() };
});

import * as guardianDashboardRoute from "@/app/api/v1/guardian/dashboard/route";
import * as guardianFoodRoute from "@/app/api/v1/guardian/food/route";
import * as guardianNoticesRoute from "@/app/api/v1/guardian/notices/route";
import * as guardianPaymentsRoute from "@/app/api/v1/guardian/payments/route";
import * as guardianSafetyRoute from "@/app/api/v1/guardian/safety-summary/route";
import * as adminComplaintsRoute from "@/app/api/v1/hostel-admin/complaints/route";
import * as adminComplaintReplyRoute from "@/app/api/v1/hostel-admin/complaints/[id]/reply/route";
import * as adminComplaintStatusRoute from "@/app/api/v1/hostel-admin/complaints/[id]/status/route";
import * as adminNightStatusRoute from "@/app/api/v1/hostel-admin/night-status/route";
import * as adminNightStatusOverrideRoute from "@/app/api/v1/hostel-admin/night-status/[residentId]/override/route";
import * as moveInRoute from "@/app/api/v1/hostel-admin/residents/[id]/move-in/route";
import * as moveOutRoute from "@/app/api/v1/hostel-admin/residents/[id]/move-out/route";
import * as adminSOSAlertsRoute from "@/app/api/v1/hostel-admin/sos-alerts/route";
import * as adminSOSStatusRoute from "@/app/api/v1/hostel-admin/sos-alerts/[id]/status/route";
import * as mobileDeviceTokenRoute from "@/app/api/v1/mobile/device-token/route";
import * as notificationsRoute from "@/app/api/v1/notifications/route";
import * as notificationReadRoute from "@/app/api/v1/notifications/[id]/read/route";
import * as platformReviewsRoute from "@/app/api/v1/platform/reviews/route";
import * as platformReviewHideRoute from "@/app/api/v1/platform/reviews/[id]/hide/route";
import * as platformReviewUnhideRoute from "@/app/api/v1/platform/reviews/[id]/unhide/route";
import * as publicHostelReviewsRoute from "@/app/api/v1/public/hostels/[slug]/reviews/route";
import * as residentComplaintsRoute from "@/app/api/v1/resident/complaints/route";
import * as residentComplaintConfirmRoute from "@/app/api/v1/resident/complaints/[id]/confirm-resolution/route";
import * as residentEmergencyContactsRoute from "@/app/api/v1/resident/emergency-contacts/route";
import * as residentNightStatusRoute from "@/app/api/v1/resident/night-status/route";
import * as residentReviewsRoute from "@/app/api/v1/resident/reviews/route";
import * as residentSOSRoute from "@/app/api/v1/resident/sos/route";
import { Role } from "@/lib/roles";

const hostelId = "64f0f0f0f0f0f0f0f0f0f0d1";
const userId = "64f0f0f0f0f0f0f0f0f0f0d2";
const entityId = "64f0f0f0f0f0f0f0f0f0f0d3";

const staffPrincipal = {
  hostelIds: [hostelId],
  role: Role.HOSTEL_ADMIN,
  sessionId: "session-1",
  userId,
};

const residentPrincipal = {
  hostelIds: [hostelId],
  role: Role.RESIDENT,
  sessionId: "session-2",
  userId,
};

const guardianPrincipal = {
  hostelIds: [hostelId],
  role: Role.GUARDIAN,
  sessionId: "session-3",
  userId,
};

const platformPrincipal = {
  hostelIds: [],
  role: Role.SUPERADMIN,
  sessionId: "session-4",
  userId,
};

function routeContext<T extends Record<string, string>>(params: T) {
  return {
    params: Promise.resolve(params),
  };
}

function request(
  path: string,
  options: {
    body?: unknown;
    method?: "GET" | "POST" | "PATCH";
  } = {},
) {
  return new NextRequest(`https://hostelpalika.local${path}`, {
    body: options.body ? JSON.stringify(options.body) : undefined,
    headers: options.body ? { "content-type": "application/json" } : {},
    method: options.method ?? "GET",
  });
}

describe("daily operations routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeMocks.requireApiPrincipal.mockResolvedValue(residentPrincipal);
    routeMocks.requireGuardianPrincipal.mockResolvedValue(guardianPrincipal);
    routeMocks.requireHostelStaffPrincipal.mockResolvedValue(staffPrincipal);
    routeMocks.requireHostelCapability.mockResolvedValue(staffPrincipal);
    routeMocks.requirePlatformPrincipal.mockResolvedValue(platformPrincipal);
    routeMocks.requireResidentPrincipal.mockResolvedValue(residentPrincipal);
  });

  it("handles resident complaint create/list and resolution confirmation", async () => {
    routeMocks.createComplaint.mockResolvedValue({ complaint: { id: entityId } });
    routeMocks.listResidentComplaints.mockResolvedValue({ complaints: [] });
    routeMocks.confirmComplaintResolution.mockResolvedValue({
      complaint: { confirmedAt: "2030-01-02T00:00:00.000Z", id: entityId },
    });

    const createResponse = await residentComplaintsRoute.POST(
      request("/api/v1/resident/complaints", {
        body: {
          attachmentAssetIds: ["asset-1"],
          category: "ROOM",
          description: "The room lock is damaged.",
          isAnonymous: true,
          title: "Broken lock",
        },
        method: "POST",
      }),
    );
    const listResponse = await residentComplaintsRoute.GET(
      request("/api/v1/resident/complaints"),
    );
    const confirmResponse = await residentComplaintConfirmRoute.PATCH(
      request(`/api/v1/resident/complaints/${entityId}/confirm-resolution`, {
        body: { note: "Resolved now." },
        method: "PATCH",
      }),
      routeContext({ id: entityId }),
    );

    expect(createResponse.status).toBe(201);
    expect(listResponse.status).toBe(200);
    expect(confirmResponse.status).toBe(200);
    expect(routeMocks.createComplaint).toHaveBeenCalledWith(
      expect.objectContaining({ isAnonymous: true, title: "Broken lock" }),
      residentPrincipal,
    );
  });

  it("handles hostel admin complaint list, reply, and status update", async () => {
    routeMocks.listAdminComplaints.mockResolvedValue({
      complaints: [],
      summary: { total: 0 },
    });
    routeMocks.replyToComplaint.mockResolvedValue({ complaint: { id: entityId } });
    routeMocks.updateComplaintStatus.mockResolvedValue({
      complaint: { id: entityId, status: "RESOLVED" },
    });

    const listResponse = await adminComplaintsRoute.GET(
      request("/api/v1/hostel-admin/complaints?status=PENDING&category=ROOM"),
    );
    const replyResponse = await adminComplaintReplyRoute.POST(
      request(`/api/v1/hostel-admin/complaints/${entityId}/reply`, {
        body: { message: "Maintenance team assigned." },
        method: "POST",
      }),
      routeContext({ id: entityId }),
    );
    const statusResponse = await adminComplaintStatusRoute.PATCH(
      request(`/api/v1/hostel-admin/complaints/${entityId}/status`, {
        body: { response: "Lock replaced.", status: "RESOLVED" },
        method: "PATCH",
      }),
      routeContext({ id: entityId }),
    );

    expect(listResponse.status).toBe(200);
    expect(replyResponse.status).toBe(201);
    expect(statusResponse.status).toBe(200);
    expect(routeMocks.listAdminComplaints).toHaveBeenCalledWith(
      { category: "ROOM", status: "PENDING" },
      staffPrincipal,
    );
  });

  it("handles night status and SOS routes without GPS fields", async () => {
    routeMocks.getResidentNightStatus.mockResolvedValue({
      status: { checkedAt: null, status: "NOT_VERIFIED" },
    });
    routeMocks.updateResidentNightStatus.mockResolvedValue({
      status: { checkedAt: "2030-01-01T00:00:00.000Z", status: "MARKED_SAFE" },
    });
    routeMocks.listAdminNightStatus.mockResolvedValue({ statuses: [], summary: {} });
    routeMocks.overrideNightStatus.mockResolvedValue({
      status: { status: "INSIDE_HOSTEL" },
    });
    routeMocks.triggerSOS.mockResolvedValue({ alert: { id: entityId } });
    routeMocks.listResidentEmergencyContacts.mockResolvedValue({ contacts: [] });
    routeMocks.listAdminSOSAlerts.mockResolvedValue({ alerts: [] });
    routeMocks.updateSOSAlertStatus.mockResolvedValue({
      alert: { id: entityId, status: "ACKNOWLEDGED" },
    });

    const residentGet = await residentNightStatusRoute.GET(
      request("/api/v1/resident/night-status"),
    );
    const residentPost = await residentNightStatusRoute.POST(
      request("/api/v1/resident/night-status", {
        body: { status: "MARKED_SAFE" },
        method: "POST",
      }),
    );
    const adminList = await adminNightStatusRoute.GET(
      request("/api/v1/hostel-admin/night-status?status=MARKED_SAFE"),
    );
    const override = await adminNightStatusOverrideRoute.PATCH(
      request(`/api/v1/hostel-admin/night-status/${entityId}/override`, {
        body: { reason: "Resident checked in at gate.", status: "INSIDE_HOSTEL" },
        method: "PATCH",
      }),
      routeContext({ residentId: entityId }),
    );
    const sos = await residentSOSRoute.POST(
      request("/api/v1/resident/sos", {
        body: { guardianAlertEnabled: true, message: "Need help" },
        method: "POST",
      }),
    );
    const contacts = await residentEmergencyContactsRoute.GET(
      request("/api/v1/resident/emergency-contacts"),
    );
    const alerts = await adminSOSAlertsRoute.GET(
      request("/api/v1/hostel-admin/sos-alerts?status=ACTIVE"),
    );
    const alertStatus = await adminSOSStatusRoute.PATCH(
      request(`/api/v1/hostel-admin/sos-alerts/${entityId}/status`, {
        body: { status: "ACKNOWLEDGED" },
        method: "PATCH",
      }),
      routeContext({ id: entityId }),
    );

    expect(residentGet.status).toBe(200);
    expect(residentPost.status).toBe(200);
    expect(adminList.status).toBe(200);
    expect(override.status).toBe(200);
    expect(sos.status).toBe(201);
    expect(contacts.status).toBe(200);
    expect(alerts.status).toBe(200);
    expect(alertStatus.status).toBe(200);
    expect(routeMocks.updateResidentNightStatus).toHaveBeenCalledWith(
      { status: "MARKED_SAFE" },
      residentPrincipal,
    );
  });

  it("serves the limited guardian views", async () => {
    routeMocks.getGuardianDashboard.mockResolvedValue({ dashboard: {} });
    routeMocks.listGuardianPayments.mockResolvedValue({ payments: [] });
    routeMocks.listGuardianNotices.mockResolvedValue({ notices: [] });
    routeMocks.listGuardianFood.mockResolvedValue({ food: [] });
    routeMocks.getGuardianSafetySummary.mockResolvedValue({ safety: {} });

    const dashboard = await guardianDashboardRoute.GET(
      request("/api/v1/guardian/dashboard"),
    );
    const payments = await guardianPaymentsRoute.GET(
      request("/api/v1/guardian/payments"),
    );
    const notices = await guardianNoticesRoute.GET(request("/api/v1/guardian/notices"));
    const food = await guardianFoodRoute.GET(request("/api/v1/guardian/food"));
    const safety = await guardianSafetyRoute.GET(
      request("/api/v1/guardian/safety-summary"),
    );

    expect(dashboard.status).toBe(200);
    expect(payments.status).toBe(200);
    expect(notices.status).toBe(200);
    expect(food.status).toBe(200);
    expect(safety.status).toBe(200);
  });

  it("handles move-in and move-out checklist routes", async () => {
    routeMocks.getMoveInChecklist.mockResolvedValue({ checklist: null });
    routeMocks.createMoveInChecklist.mockResolvedValue({ checklist: { id: entityId } });
    routeMocks.getMoveOutChecklist.mockResolvedValue({ checklist: null });
    routeMocks.createMoveOutChecklist.mockResolvedValue({
      checklist: { id: entityId },
    });

    const getMoveIn = await moveInRoute.GET(
      request(`/api/v1/hostel-admin/residents/${entityId}/move-in`),
      routeContext({ id: entityId }),
    );
    const postMoveIn = await moveInRoute.POST(
      request(`/api/v1/hostel-admin/residents/${entityId}/move-in`, {
        body: { documentsCollected: ["citizenship"], rulesAccepted: true },
        method: "POST",
      }),
      routeContext({ id: entityId }),
    );
    const getMoveOut = await moveOutRoute.GET(
      request(`/api/v1/hostel-admin/residents/${entityId}/move-out`),
      routeContext({ id: entityId }),
    );
    const postMoveOut = await moveOutRoute.POST(
      request(`/api/v1/hostel-admin/residents/${entityId}/move-out`, {
        body: { depositRefundAmount: 1000, depositRefundDecision: "PARTIAL" },
        method: "POST",
      }),
      routeContext({ id: entityId }),
    );

    expect(getMoveIn.status).toBe(200);
    expect(postMoveIn.status).toBe(201);
    expect(getMoveOut.status).toBe(200);
    expect(postMoveOut.status).toBe(201);
  });

  it("handles reviews, notifications, and mobile device tokens", async () => {
    routeMocks.createResidentReview.mockResolvedValue({ review: { id: entityId } });
    routeMocks.listPublicHostelReviews.mockResolvedValue({ reviews: [], summary: {} });
    routeMocks.listPlatformReviews.mockResolvedValue({ reviews: [] });
    routeMocks.hideReview.mockResolvedValue({ review: { id: entityId } });
    routeMocks.unhideReview.mockResolvedValue({ review: { id: entityId } });
    routeMocks.listNotifications.mockResolvedValue({ notifications: [] });
    routeMocks.markNotificationRead.mockResolvedValue({
      notification: { id: entityId, isRead: true },
    });
    routeMocks.saveDeviceToken.mockResolvedValue({ deviceToken: { id: entityId } });

    const residentReview = await residentReviewsRoute.POST(
      request("/api/v1/resident/reviews", {
        body: { comment: "Good hostel.", overallRating: 5 },
        method: "POST",
      }),
    );
    const publicReviews = await publicHostelReviewsRoute.GET(
      request(`/api/v1/public/hostels/${hostelId}/reviews`),
      routeContext({ slug: hostelId }),
    );
    const platformReviews = await platformReviewsRoute.GET(
      request("/api/v1/platform/reviews?status=VISIBLE"),
    );
    const hide = await platformReviewHideRoute.PATCH(
      request(`/api/v1/platform/reviews/${entityId}/hide`, {
        body: { reason: "Abusive" },
        method: "PATCH",
      }),
      routeContext({ id: entityId }),
    );
    const unhide = await platformReviewUnhideRoute.PATCH(
      request(`/api/v1/platform/reviews/${entityId}/unhide`, {
        body: {},
        method: "PATCH",
      }),
      routeContext({ id: entityId }),
    );
    const notifications = await notificationsRoute.GET(request("/api/v1/notifications"));
    const read = await notificationReadRoute.PATCH(
      request(`/api/v1/notifications/${entityId}/read`, {
        body: {},
        method: "PATCH",
      }),
      routeContext({ id: entityId }),
    );
    const token = await mobileDeviceTokenRoute.POST(
      request("/api/v1/mobile/device-token", {
        body: { platform: "ANDROID", token: "fcm-token-123" },
        method: "POST",
      }),
    );

    expect(residentReview.status).toBe(201);
    expect(publicReviews.status).toBe(200);
    expect(platformReviews.status).toBe(200);
    expect(hide.status).toBe(200);
    expect(unhide.status).toBe(200);
    expect(notifications.status).toBe(200);
    expect(read.status).toBe(200);
    expect(token.status).toBe(201);
  });

  it("rejects invalid daily operation payloads before calling services", async () => {
    /*
     * A complaint with neither typed words nor a recording.
     *
     * This used to be `{ description: "Bad" }`, which was invalid only because
     * `title` was mandatory and `description` had a 5-character floor. Both went
     * when the app's raise screen dropped the title field, so the payload that
     * must still be refused is the one carrying nothing to read or listen to —
     * `complaintCreateSchema`'s `refine`.
     */
    const complaintResponse = await residentComplaintsRoute.POST(
      request("/api/v1/resident/complaints", {
        body: { category: "FOOD" },
        method: "POST",
      }),
    );
    const sosResponse = await adminSOSStatusRoute.PATCH(
      request(`/api/v1/hostel-admin/sos-alerts/${entityId}/status`, {
        body: { status: "ACTIVE" },
        method: "PATCH",
      }),
      routeContext({ id: entityId }),
    );

    expect(complaintResponse.status).toBe(422);
    expect(sosResponse.status).toBe(422);
    expect(routeMocks.createComplaint).not.toHaveBeenCalled();
    expect(routeMocks.updateSOSAlertStatus).not.toHaveBeenCalled();
  });
});
