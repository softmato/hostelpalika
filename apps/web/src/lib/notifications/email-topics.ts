/**
 * The emails a person can turn off, and the copy for them. **Pure** — the public
 * preferences page renders from it.
 *
 * Everything else is always sent: sign-in codes, credentials, receipts, plan
 * invoices and reminders, SOS, account and privacy mail.
 *
 * Mirrored in `apps/mobile/src/lib/notification-preferences.ts` (`EMAIL_TOPICS`);
 * change both.
 */
export const EMAIL_TOPICS = [
  {
    audience: "resident",
    description: "Before and after your hostel fee is due",
    label: "Rent reminders",
    value: "RENT_REMINDERS",
  },
  {
    audience: "resident",
    description: "Urgent notices from your hostel",
    label: "Notices",
    value: "NOTICES",
  },
  {
    audience: "resident",
    description: "When a complaint you raised is resolved or rejected",
    label: "Complaint updates",
    value: "COMPLAINT_UPDATES",
  },
  {
    audience: "staff",
    description: "Morning summary of payments to verify and received, and unpaid fees",
    label: "Payment summaries",
    value: "PAYMENT_SUMMARY",
  },
  {
    audience: "staff",
    description: "New complaints, and ones past their deadline",
    label: "Complaint alerts",
    value: "COMPLAINT_ALERTS",
  },
  {
    audience: "staff",
    description: "Residents away longer than your alert limit",
    label: "Attendance alerts",
    value: "ATTENDANCE_ALERTS",
  },
] as const;

export type EmailTopic = (typeof EMAIL_TOPICS)[number]["value"];
export type EmailAudience = (typeof EMAIL_TOPICS)[number]["audience"];

export const EMAIL_TOPIC_VALUES = EMAIL_TOPICS.map((topic) => topic.value) as [
  EmailTopic,
  ...EmailTopic[],
];

export function isEmailTopic(value: unknown): value is EmailTopic {
  return EMAIL_TOPIC_VALUES.includes(value as EmailTopic);
}

export function emailTopic(value: EmailTopic) {
  return EMAIL_TOPICS.find((topic) => topic.value === value)!;
}
