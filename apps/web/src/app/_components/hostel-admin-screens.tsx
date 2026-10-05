import type { ReactNode } from "react";

import { HostelAdminAttendancePageContent } from "@/app/_components/hostel-admin-attendance-page";
import { HostelAdminBillingPageContent } from "@/app/_components/hostel-admin-billing-page";
import { HostelAdminBookingsPage } from "@/app/_components/hostel-admin-bookings-page";
import { HostelBranchesPageContent } from "@/app/_components/hostel-branches-page";
import { HostelAdminCommunityPageContent } from "@/app/_components/hostel-admin-community-page";
import { HostelAdminComplaintsPage } from "@/app/_components/hostel-admin-complaints-page";
import { HostelAdminDashboardPageContent } from "@/app/_components/hostel-admin-dashboard-page";
import { HostelAdminExistingResidentsPage } from "@/app/_components/hostel-admin-existing-residents-page";
import { HostelAdminExpensesPageContent } from "@/app/_components/hostel-admin-expenses-page";
import { HostelAdminFeeSchedulePageContent } from "@/app/_components/hostel-admin-fee-schedule-page";
import { HostelAdminFoodPage } from "@/app/_components/hostel-admin-food-page";
import { HostelAdminInquiriesPageContent } from "@/app/_components/hostel-admin-inquiries-page";
import { HostelAdminInviteHostelsPageContent } from "@/app/_components/hostel-admin-invite-hostels-page";
import { HostelAdminMaintenancePageContent } from "@/app/_components/hostel-admin-maintenance-page";
import { HostelAdminMoveChecklistPage } from "@/app/_components/hostel-admin-move-checklist-page";
import { HostelAdminNightStatusPage } from "@/app/_components/hostel-admin-night-status-page";
import { HostelAdminNoticesPage } from "@/app/_components/hostel-admin-notices-page";
import { HostelAdminNotificationsPageContent } from "@/app/_components/hostel-admin-notifications-page";
import { HostelAdminPaymentGatewaysPageContent } from "@/app/_components/hostel-admin-payment-gateways-page";
import { HostelAdminPaymentProfilePageContent } from "@/app/_components/hostel-admin-payment-profile-page";
import { HostelAdminPaymentsPage } from "@/app/_components/hostel-admin-payments-page";
import { HostelAdminProfilePageContent } from "@/app/_components/hostel-admin-profile-page";
import { HostelAdminReconcilePageContent } from "@/app/_components/hostel-admin-reconcile-page";
import { HostelAdminKycPageContent } from "@/app/_components/hostel-admin-kyc-page";
import { HostelAdminKhataPageContent } from "@/app/_components/khata-pages";
import { HostelAdminReferralsPageContent } from "@/app/_components/hostel-admin-referrals-page";
import { HostelAdminReportsPageContent } from "@/app/_components/hostel-admin-reports-page";
import { HostelAdminResidentsPage } from "@/app/_components/hostel-admin-residents-page";
import { HostelAdminRoomsPageContent } from "@/app/_components/hostel-admin-rooms-page";
import { HostelAdminSettingsPageContent } from "@/app/_components/hostel-admin-settings-page";
import { HostelAdminSOSAlertsPage } from "@/app/_components/hostel-admin-sos-alerts-page";
import { HostelAdminStockPageContent } from "@/app/_components/hostel-admin-stock-page";
import { HostelAdminTransactionsPageContent } from "@/app/_components/hostel-admin-transactions-page";
import { HostelAdminWardensPage } from "@/app/_components/hostel-admin-wardens-page";
import { NotificationsPageContent } from "@/app/_components/notifications-page";

/**
 * Every screen of the hostel-owner portal, keyed by the URL segment after
 * `/{hostelSlug}/admin/`. Keeping them in one registry means the tenant-scoped
 * catch-all route stays a single file instead of one wrapper per tab.
 */
export const HOSTEL_ADMIN_SCREENS: Record<string, (slug: string) => ReactNode> = {
  attendance: () => <HostelAdminAttendancePageContent />,
  bookings: () => <HostelAdminBookingsPage />,
  // The hostel's own plan paperwork, from Softmato. Distinct from `payments`,
  // which is residents paying this hostel — a different direction of money and
  // a different merchant of record.
  billing: () => <HostelAdminBillingPageContent />,
  community: () => <HostelAdminCommunityPageContent />,
  complaints: () => <HostelAdminComplaintsPage />,
  dashboard: () => <HostelAdminDashboardPageContent />,
  // Deviation §3.4: the fee-schedule editor **replaces** the old Fee Plans page.
  // The key stays so bookmarked links still resolve.
  "fee-plans": () => <HostelAdminFeeSchedulePageContent />,
  "fee-schedule": () => <HostelAdminFeeSchedulePageContent />,
  food: () => <HostelAdminFoodPage />,
  // The admin's *personal* notification feed. `notifications` below is the
  // outbound campaign composer — a different thing that happens to share a
  // word, which is why the bell points here instead.
  inbox: () => <NotificationsPageContent />,
  // Money Out (docs/EXPENSES_PLAN.md). A warden with `recordExpenses` sees
  // their own rows here; the server keeps the totals for the owner.
  expenses: () => <HostelAdminExpensesPageContent />,
  inquiries: () => <HostelAdminInquiriesPageContent />,
  "invite-hostels": () => <HostelAdminInviteHostelsPageContent />,
  khata: () => <HostelAdminKhataPageContent />,
  kyc: () => <HostelAdminKycPageContent />,
  maintenance: () => <HostelAdminMaintenancePageContent />,
  "move-in-out": () => <HostelAdminMoveChecklistPage />,
  "night-status": () => <HostelAdminNightStatusPage />,
  notices: () => <HostelAdminNoticesPage />,
  notifications: () => <HostelAdminNotificationsPageContent />,
  // Its own screen rather than a section of `payment-setup`: that form is a
  // broad PATCH of display text and account numbers, and a signing key must not
  // travel through it.
  "payment-gateways": () => <HostelAdminPaymentGatewaysPageContent />,
  "payment-setup": () => <HostelAdminPaymentProfilePageContent />,
  payments: () => <HostelAdminPaymentsPage />,
  profile: () => <HostelAdminProfilePageContent />,
  branches: () => <HostelBranchesPageContent />,
  reconcile: () => <HostelAdminReconcilePageContent />,
  referrals: () => <HostelAdminReferralsPageContent />,
  reports: () => <HostelAdminReportsPageContent />,
  residents: () => <HostelAdminResidentsPage />,
  "existing-residents": () => <HostelAdminExistingResidentsPage />,
  rooms: () => <HostelAdminRoomsPageContent />,
  // Merged into Maintenance — kept so bookmarked provider links still resolve.
  "service-providers": () => <HostelAdminMaintenancePageContent />,
  settings: () => <HostelAdminSettingsPageContent />,
  "sos-alerts": () => <HostelAdminSOSAlertsPage />,
  // Bought, Send, Count across the main hostel and its branches (docs/INVENTORY_PLAN.md).
  stock: () => <HostelAdminStockPageContent />,
  transactions: () => <HostelAdminTransactionsPageContent />,
  wardens: () => <HostelAdminWardensPage />,
};

export const HOSTEL_ADMIN_SCREEN_NAMES = Object.keys(HOSTEL_ADMIN_SCREENS);
