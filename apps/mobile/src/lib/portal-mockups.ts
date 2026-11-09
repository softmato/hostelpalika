import { SITE_URL } from "@/lib/site-url";

/**
 * Device mockups of the product, the same files the website shows.
 *
 * **Fetched, not bundled.** They live in `apps/web/public/mockups/` and are
 * served by the website's CDN; `expo-image` keeps them on disk after the first
 * view. Fifteen screenshots in `assets/` would add ~1.7 MB to every install and
 * every OTA update for pictures most people see once. A copy in R2 would be a
 * second copy of the website's own static files, with an upload step to forget.
 *
 * Every file is a transparent WebP with no backdrop, so it sits on either
 * theme. `aspect` is width / height of the file.
 */
export type Mockup = { alt: string; aspect: number; uri: string };

function mockup(name: string, alt: string, aspect = 1536 / 1024): Mockup {
  return { alt, aspect, uri: `${SITE_URL}/mockups/${name}.webp` };
}

export const MOCKUPS = {
  appCommunity: mockup(
    "app-public-community-hostelviewpage",
    "The app's community feed beside a hostel's public page",
  ),
  appHome: mockup(
    "app-public-facing",
    "The app's home screen with top picks and nearby hostels",
    1230 / 1278,
  ),
  appMap: mockup("app-public-map-screen", "Hostels on the map with walking directions"),
  guardianPortal: mockup("guardian-portal", "The guardian portal on a laptop and a phone"),
  residentFees: mockup("resident-portal-feepayment", "A resident's fees and payments"),
  residentPortal: mockup("resident-portal", "The resident portal dashboard"),
  residentProfile: mockup("resident-portal-profile", "A resident's profile and ID card"),
  residentRegister: mockup(
    "resident-register-whole-process",
    "Registering a resident, step by step, in the app",
  ),
  residentVerify: mockup(
    "resident-register-process-step-2",
    "Confirming a resident's identity after scanning their card",
  ),
  wardenDashboard: mockup("warden-dashboard", "The hostel dashboard on a laptop and a phone"),
  wardenFinance: mockup("warden-dashboard-finance", "The fee schedule and statement reconcile"),
  wardenPaymentSetup: mockup(
    "warden-paymentsetup-statement",
    "Payment setup with eSewa, Khalti and bank accounts",
  ),
  wardenRooms: mockup("warden-room-management", "Rooms and bed rates by sharing type"),
  wardenTransactions: mockup("warden-dashboard-transaction", "The hostel's transactions list"),
} as const;
