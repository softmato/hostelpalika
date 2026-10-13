import {
  ctaButton,
  detailsTable,
  emailDate,
  emailLayout,
  escapeHtml,
  monthName,
  paragraph,
  sectionTitle,
  smallPrint,
  type EmailContent,
} from "../layout";

/**
 * How this resident signs in, which is the one thing the mail cannot guess.
 *
 * `EXISTING_ACCOUNT` — the intake found an account that already belongs to them
 * and promoted it, so their password or Google sign-in is unchanged and there is
 * nothing to activate.
 *
 * `ACTIVATION_CODE` — nobody could be linked: registered phone-only, or with an
 * address that belongs to no account. Residents are **never** sent credentials
 * (`linkResidentAccount`), so the honest sentence is that the hostel will hand
 * them a code, not a promise of a login that does not exist.
 *
 * `NEW_ACCOUNT` — registered off the admission form, and the form's email had
 * no account, so this registration made one. No password exists to send: they
 * sign in with Google on that address, or set one through "Forgot password".
 */
export type ResidentSignIn = "ACTIVATION_CODE" | "EXISTING_ACCOUNT" | "NEW_ACCOUNT";

/**
 * The confirmation a resident gets the moment a hostel registers them.
 *
 * ## Why this exists alongside `residentLinkedEmail`
 *
 * That one is sent only when an account was found and promoted, and it is about
 * the *portal*: sign in as you always did. So a resident registered at the desk
 * with no platform account — which is most of them, on the day they arrive —
 * received nothing at all. They had just handed over a deposit and an admission
 * fee and been given a bed, and the product's entire record of it was a row on
 * somebody else's screen.
 *
 * This is the record of the arrangement: which hostel, which room, from when,
 * what the rent is, what was charged today and what they owe for their first
 * month. It is the thing a resident goes looking for in three weeks when they
 * cannot remember what they agreed to, and the thing they can forward to whoever
 * is paying for them.
 *
 * ## Every figure is optional and every one is dropped rather than guessed
 *
 * A hostel that charges no admission fee, takes no deposit, or has not priced
 * the room type yet is a real hostel, not an error. A line that said
 * "Admission fee: NPR 0" over the first is worse than no line, and one that
 * printed a rent nobody has set would be a claim about money that is false.
 */
export function residentRegisteredEmail(input: {
  admissionFee?: number | null;
  currency?: string;
  dashboardUrl: string;
  depositAmount?: number | null;
  /** The first month's rent, when the intake managed to invoice it. */
  firstMonth?: {
    amount: number;
    dueDate?: Date | null;
    /** `2026-09`. */
    period: string;
    prorated: boolean;
    referenceCode?: string | null;
  } | null;
  hostelName: string;
  monthlyRent?: number | null;
  moveInDate: Date;
  residentName: string;
  roomNumber?: string | null;
  roomType: string;
  signIn: ResidentSignIn;
  /** The address they sign in with, for `NEW_ACCOUNT`. */
  signInEmail?: string;
}): EmailContent {
  const currency = input.currency ?? "NPR";
  const money = (value?: number | null) =>
    value ? `${currency} ${value.toLocaleString("en-US")}` : "";
  const first = input.firstMonth;

  /*
   * The first month is its own table because it is the only figure here that is
   * *owed* — the rest describe the arrangement. A part month says so, or an
   * amount under the rent reads as a mistake.
   */
  const firstMonth = first
    ? [
        sectionTitle("To pay now"),
        detailsTable([
          { label: "Month", value: monthName(first.period) },
          { emphasis: true, label: "Amount", value: money(first.amount) },
          { label: "Pay by", value: emailDate(first.dueDate) ?? "" },
          { label: "Reference code", value: first.referenceCode ?? "" },
        ]),
        first.prorated ? smallPrint("Only from the day you move in, not the full month.") : "",
        first.referenceCode
          ? smallPrint("Write the reference code when you pay, so the hostel knows it is you.")
          : "",
      ].join("\n")
    : "";

  return {
    category: "info",
    subject: `Welcome to ${input.hostelName}`,
    html: emailLayout({
      heading: "Welcome to your hostel",
      bodyHtml: [
        paragraph(
          `Hi ${escapeHtml(input.residentName)}, <strong>${escapeHtml(input.hostelName)}</strong> added you as a resident.`,
        ),
        detailsTable([
          {
            label: "Room",
            value: [input.roomType.replaceAll("_", " "), input.roomNumber].filter(Boolean).join(" · "),
          },
          { label: "Moving in", value: emailDate(input.moveInDate) ?? "" },
          { label: "Monthly rent", value: money(input.monthlyRent) },
          { label: "Admission fee", value: money(input.admissionFee) },
          { label: "Deposit", value: money(input.depositAmount) },
        ]),
        firstMonth,
        ctaButton(input.dashboardUrl, "Open my account"),
        smallPrint(
          input.signIn === "EXISTING_ACCOUNT"
            ? "Log in the same way as before. No new password needed."
            : input.signIn === "NEW_ACCOUNT"
              ? `Your account is ready on ${escapeHtml(input.signInEmail ?? "this email")}. Log in with Google, or tap “Forgot password” on the login page to set one.`
              : "To use the app, ask the hostel for your code.",
        ),
        smallPrint("Something wrong? Tell the hostel before you pay."),
      ]
        .filter(Boolean)
        .join("\n"),
    }),
  };
}
