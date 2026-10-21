/**
 * What a leaving hostel's data handover can include — the superadmin ticks
 * these before approving (docs/HOSTEL_LEAVE_PLATFORM.md). Each becomes one
 * sheet of the workbook (and one key of the JSON), from the hostel's first day
 * to today. `description` is the line the workbook's About sheet gives it.
 */
export const HOSTEL_LEAVE_SECTIONS = [
  { key: "residents", label: "Residents", description: "Everyone who has lived here, current and moved out." },
  { key: "rooms", label: "Rooms and beds", description: "Each room, its floor, type and number of beds." },
  { key: "bills", label: "Rent bills", description: "Every bill raised to a resident, what was paid on it and its status." },
  { key: "payments", label: "Payments", description: "Every payment in and refund out, with how it was paid." },
  { key: "receipts", label: "Receipts", description: "Every receipt issued, with its number." },
  { key: "deposits", label: "Deposits", description: "Security deposits taken and refunded." },
  { key: "khata", label: "Khata", description: "Items residents took on account." },
  { key: "expenses", label: "Expenses", description: "Money the hostel spent." },
  { key: "stock", label: "Stock", description: "Stock bought, used, moved and counted, one line per item." },
  { key: "food", label: "Food menu", description: "The weekly menu and meal times." },
  { key: "complaints", label: "Complaints", description: "Complaints from residents and your replies." },
  { key: "repairs", label: "Repairs", description: "Repair and maintenance jobs." },
  { key: "attendance", label: "Attendance", description: "Check-ins: the zone only, never a location." },
  { key: "notices", label: "Notices", description: "Notices sent to residents." },
  { key: "files", label: "Files list", description: "Every file uploaded: photos, documents and receipts, by name." },
] as const;

export type HostelLeaveSection = (typeof HOSTEL_LEAVE_SECTIONS)[number]["key"];

export const HOSTEL_LEAVE_SECTION_KEYS = HOSTEL_LEAVE_SECTIONS.map(
  (section) => section.key,
) as [HostelLeaveSection, ...HostelLeaveSection[]];

/**
 * The "Your data stays yours" promise — shown on the plans pages, plan billing
 * and KYC, web and app alike, so an owner knows before they join that they can
 * leave with everything. `hold` is the platform's claim-back window; unknown,
 * it says so without a number rather than inventing one.
 */
export function hostelLeavePromise(hold?: { max: number; min: number } | null) {
  const days = !hold ? "a few days" : hold.min === hold.max ? `${hold.max} days` : `${hold.min} to ${hold.max} days`;

  return {
    points: [
      {
        body: "From Settings, whenever you want, once your plan bills are paid. No lock-in.",
        icon: "log-out",
        title: "Leave any time",
      },
      {
        body: "Residents, bills, payments, receipts, expenses, stock, food menu and more, from your first day: an Excel workbook, plus a file other software can import.",
        icon: "download",
        title: "Take all your data",
      },
      {
        body: `We hold your hostel for ${days} after you leave. Claim it back in that time and everything is exactly as you left it.`,
        icon: "refresh",
        title: "Change your mind",
      },
    ],
    title: "Your data stays yours",
  } as const;
}
