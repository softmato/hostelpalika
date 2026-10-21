import {
  ctaButton,
  detailsTable,
  emailDate,
  emailLayout,
  escapeHtml,
  greeting,
  paragraph,
  smallPrint,
  type EmailContent,
} from "../layout";

/**
 * Leaving the platform (docs/HOSTEL_LEAVE_PLATFORM.md): the owner's copy of the
 * request, our team's notice of it, and the three outcomes.
 */

/** To the owner, the moment the request is sent. */
export function hostelLeaveRequestedEmail(input: {
  holdDays: number;
  hostelName: string;
  ownerName?: string;
  pageUrl: string;
}): EmailContent {
  return {
    category: "info",
    subject: `We got your request to leave — ${input.hostelName}`,
    html: emailLayout({
      heading: "Request to leave received",
      bodyHtml: [
        greeting(input.ownerName),
        paragraph(
          `We got your request to take <strong>${escapeHtml(input.hostelName)}</strong> off HostelPalika. Our team will check it and write to you.`,
        ),
        detailsTable([
          { label: "Hostel", value: input.hostelName },
          { label: "We hold your data for", value: `${input.holdDays} days after approval` },
        ]),
        paragraph("Nothing changes until we approve it. You can cancel it until then."),
        ctaButton(input.pageUrl, "Open request"),
      ].join("\n"),
    }),
  };
}

/** To platform staff: a hostel wants to leave. */
export function hostelLeavePendingEmail(input: {
  holdDays: number;
  hostelName: string;
  ownerEmail?: string;
  ownerName?: string;
  queueUrl: string;
  reason: string;
}): EmailContent {
  return {
    category: "info",
    subject: `Hostel wants to leave — ${input.hostelName}`,
    html: emailLayout({
      heading: "Hostel wants to leave",
      bodyHtml: [
        paragraph("A hostel owner asked to take their hostel off HostelPalika. Their plan bills are cleared."),
        detailsTable([
          { label: "Hostel", value: input.hostelName },
          { label: "Owner", value: input.ownerName ?? "" },
          { label: "Email", value: input.ownerEmail ?? "" },
          { label: "Hold data for", value: `${input.holdDays} days` },
          { label: "Reason", value: input.reason },
        ]),
        ctaButton(input.queueUrl, "Review request"),
      ].join("\n"),
    }),
  };
}

/** To the owner on approval, with the data files attached. */
export function hostelLeaveApprovedEmail(input: {
  claimUrl: string;
  files: string[];
  holdUntil: Date;
  hostelName: string;
  ownerName?: string;
  /** The workbook's sheets, in order. */
  sheets: string[];
}): EmailContent {
  const until = emailDate(input.holdUntil) ?? "";

  return {
    category: "info",
    subject: `${input.hostelName} is off HostelPalika`,
    html: emailLayout({
      heading: "Your hostel is off HostelPalika",
      bodyHtml: [
        greeting(input.ownerName),
        paragraph(
          `We approved your request. <strong>${escapeHtml(input.hostelName)}</strong> is no longer on HostelPalika, and its portal is closed.`,
        ),
        input.files.length > 0
          ? [
              paragraph("Your hostel's data, from its first day to today, is attached in two files:"),
              detailsTable([
                { label: input.files.find((file) => file.endsWith(".xlsx")) ?? "Workbook", value: "Excel / Google Sheets" },
                { label: input.files.find((file) => file.endsWith(".json")) ?? "JSON", value: "To import into other software" },
              ]),
              paragraph(
                `The workbook opens on an About sheet that explains the rest. Its sheets: ${input.sheets.map(escapeHtml).join(", ")}.`,
              ),
            ].join("\n")
          : "",
        detailsTable([{ emphasis: true, label: "We hold your data until", value: until }]),
        paragraph(
          "Changed your mind? Sign in with this email before that date and claim your hostel back. Everything comes back as it was.",
        ),
        ctaButton(input.claimUrl, "Claim hostel back"),
        smallPrint("After that date your hostel and its data are erased for good."),
      ].join("\n"),
    }),
  };
}

/** To the owner when our team does not approve it. */
export function hostelLeaveRejectedEmail(input: {
  hostelName: string;
  note: string;
  ownerName?: string;
}): EmailContent {
  return {
    category: "info",
    subject: `Your request to leave was not approved — ${input.hostelName}`,
    html: emailLayout({
      heading: "Request not approved",
      bodyHtml: [
        greeting(input.ownerName),
        paragraph(
          `We did not approve the request to take <strong>${escapeHtml(input.hostelName)}</strong> off HostelPalika. Your hostel stays as it is.`,
        ),
        paragraph(`Reason: ${escapeHtml(input.note)}`),
        paragraph("Questions? Reply to this email."),
      ].join("\n"),
    }),
  };
}

/** To the owner after they claim the hostel back. */
export function hostelReclaimedEmail(input: {
  hostelName: string;
  ownerName?: string;
  portalUrl: string;
}): EmailContent {
  return {
    category: "info",
    subject: `${input.hostelName} is back on HostelPalika`,
    html: emailLayout({
      heading: "Your hostel is back",
      bodyHtml: [
        greeting(input.ownerName),
        paragraph(
          `You claimed <strong>${escapeHtml(input.hostelName)}</strong> back. Its portal and data are as you left them.`,
        ),
        ctaButton(input.portalUrl, "Open portal"),
      ].join("\n"),
    }),
  };
}
