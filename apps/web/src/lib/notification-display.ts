import {
  Bell,
  Building2,
  CalendarCheck,
  CreditCard,
  Megaphone,
  MessageSquare,
  Moon,
  Siren,
  Star,
  Trash2,
  UserRound,
  Utensils,
  Wrench,
  type IconComponent,
} from "@/components/icons";

/**
 * How a notification *looks*, derived from the `category` its service wrote.
 *
 * Kept out of the components so the bell, the notifications page and the
 * incoming-event toast all label the same category identically — a payment is
 * a green banknote everywhere, an SOS is a red siren everywhere.
 *
 * Categories are plain strings on the model rather than an enum (services add
 * them freely), so `notificationDisplay` always returns a usable fallback
 * instead of assuming the map is exhaustive.
 */

export type NotificationTone =
  | "amber"
  | "blue"
  | "emerald"
  | "rose"
  | "slate"
  | "violet";

type CategoryDisplay = {
  icon: IconComponent;
  label: string;
  tone: NotificationTone;
};

const CATEGORY_DISPLAY: Record<string, CategoryDisplay> = {
  ACCOUNT: { icon: UserRound, label: "Account", tone: "slate" },
  ACCOUNT_DELETION: { icon: Trash2, label: "Account", tone: "rose" },
  ANNOUNCEMENT: { icon: Megaphone, label: "Announcement", tone: "violet" },
  ATTENDANCE: { icon: UserRound, label: "Attendance", tone: "blue" },
  BOOKING: { icon: CalendarCheck, label: "Booking", tone: "emerald" },
  NIGHT_STATUS: { icon: Moon, label: "Night status", tone: "violet" },
  COMMUNITY: { icon: MessageSquare, label: "Community", tone: "violet" },
  COMPLAINT: { icon: MessageSquare, label: "Complaint", tone: "amber" },
  ELECTRICIAN: { icon: Wrench, label: "Maintenance", tone: "amber" },
  FOOD: { icon: Utensils, label: "Food", tone: "emerald" },
  GENERAL: { icon: Bell, label: "General", tone: "slate" },
  GUARDIAN: { icon: UserRound, label: "Guardian", tone: "blue" },
  HOSTEL_APPROVAL: { icon: Building2, label: "Hostel approval", tone: "blue" },
  INQUIRY: { icon: MessageSquare, label: "Inquiry", tone: "blue" },
  MAINTENANCE: { icon: Wrench, label: "Maintenance", tone: "amber" },
  NOTICE: { icon: Megaphone, label: "Notice", tone: "violet" },
  PAYMENT: { icon: CreditCard, label: "Payment", tone: "emerald" },
  PLUMBER: { icon: Wrench, label: "Maintenance", tone: "amber" },
  REVIEW: { icon: Star, label: "Review", tone: "amber" },
  ROOM: { icon: Building2, label: "Room", tone: "blue" },
  SERVICE_PROVIDER: { icon: Wrench, label: "Service provider", tone: "blue" },
  SOS: { icon: Siren, label: "SOS", tone: "rose" },
  URGENT: { icon: Siren, label: "Urgent", tone: "rose" },
};

const FALLBACK: CategoryDisplay = { icon: Bell, label: "Update", tone: "slate" };

export function notificationDisplay(category: string): CategoryDisplay {
  return CATEGORY_DISPLAY[category] ?? FALLBACK;
}

/** Icon chip classes per tone, light and dark. */
export const TONE_CHIP: Record<NotificationTone, string> = {
  amber: "bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400",
  blue: "bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-400",
  emerald: "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400",
  rose: "bg-rose-50 text-rose-600 dark:bg-rose-500/15 dark:text-rose-400",
  slate: "bg-slate-100 text-slate-600 dark:bg-slate-500/15 dark:text-slate-300",
  violet: "bg-violet-50 text-violet-600 dark:bg-violet-500/15 dark:text-violet-400",
};

export function relativeTime(value?: string) {
  if (!value) {
    return "";
  }

  const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60_000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;

  return `${Math.round(minutes / 1440)}d ago`;
}
