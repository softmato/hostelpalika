/** One group's sums in the usage analytics (`getUsageAnalytics`). */
export type UsageFigures = { durationMs: number; opens: number; users: number; uses: number; views: number };

/** `GET /api/v1/platform/usage` — what the superadmin's Usage page draws. */
export type UsageAnalytics = {
  byHostel: Array<UsageFigures & { hostelId: string; hostelName: string }>;
  byRole: Array<UsageFigures & { role: string }>;
  daily: Array<UsageFigures & { day: string }>;
  days: number;
  features: Array<UsageFigures & { feature: string }>;
  from: string;
  recent: Array<{ at: string; client: string; durationMs: number; feature: string; kind: string; screen: string }>;
  screens: Array<UsageFigures & { screen: string }>;
  totals: UsageFigures;
  user: { email: string | null; name: string; userId: string } | null;
  users: Array<
    UsageFigures & { email: string | null; hostelName: string | null; lastDay: string; name: string; role: string; userId: string }
  >;
};
