/**
 * The website: pages a link opens (`/hostels/<slug>`, `/pay/<ref>`, shares),
 * its static files (`/mockups`, `/brand`), and the TS standby the API breaker
 * falls back to while Go is unreachable (`lib/api.ts`). The API itself is Go,
 * `API_BASE_URL`. `EXPO_PUBLIC_SITE_URL` overrides this for a local web.
 */
export const SITE_URL = process.env.EXPO_PUBLIC_SITE_URL?.trim().replace(/\/+$/, "") || "https://hostelpalika.com";
