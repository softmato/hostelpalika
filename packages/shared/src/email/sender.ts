import {
  DEFAULT_EMAIL_CATEGORY,
  fromHeaderFor,
  replyToFor,
  resolveEmailIdentity,
  type EmailCategory,
} from "./identity";
import { UNSUBSCRIBE_SLOT } from "./templates/layout";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const RESEND_BATCH_ENDPOINT = "https://api.resend.com/emails/batch";
/** Resend takes at most this many messages per batch request. */
const BATCH_LIMIT = 100;

/**
 * A file to send alongside the email. `content` is raw bytes; the sender
 * base64-encodes them, which is what Resend's API expects.
 */
export type EmailAttachment = {
  content: Uint8Array;
  /** Shown to the recipient — include the extension. */
  filename: string;
};

export type SendEmailInput = {
  attachments?: EmailAttachment[];
  /**
   * Which mailbox this goes out from. Templates carry their own — every
   * `EmailContent` sets one — so ordinary call sites spread the template and
   * never name a category. Pass it directly only for ad-hoc mail with no
   * template behind it.
   */
  category?: EmailCategory;
  to: string | string[];
  subject: string;
  html: string;
  /** Overrides the configured reply address for this one send. */
  replyTo?: string;
  /**
   * For optional mail only. Adds an unsubscribe line to the footer (`pageUrl`)
   * and the `List-Unsubscribe` one-click headers (RFC 8058, `oneClickUrl`), which
   * Gmail and Yahoo show as their own Unsubscribe button.
   */
  unsubscribe?: { oneClickUrl: string; pageUrl: string };
};

/** The footer line, in the layout's slot — or appended to a bare HTML fragment. */
export function withUnsubscribeLine(html: string, pageUrl: string) {
  const line = `<a href="${pageUrl.replace(/&/g, "&amp;")}" style="color:inherit;text-decoration:underline;">Unsubscribe or choose which emails you get</a>`;

  return html.includes(UNSUBSCRIBE_SLOT)
    ? html.replace(UNSUBSCRIBE_SLOT, `<br>${line}`)
    : `${html}<p style="margin-top:24px;font-size:12px;line-height:18px;color:#71717a;">${line}</p>`;
}

/**
 * Resend answers 429 past its per-second limit (10 per team by default), which
 * every send on the platform shares. `sendEmail` never throws, so a 429 used to
 * be a notice marked sent that nobody received. Waits the `retry-after` it
 * names, briefly, then gives up as before. Bulk jobs use `sendEmailBatch`, which
 * stays well under the limit in the first place.
 */
async function postToResend(url: string, body: unknown, retries = 2): Promise<Response> {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  if (response.status !== 429 || retries <= 0) {
    return response;
  }

  const retryAfter = Number(response.headers.get("retry-after"));
  const waitMs = (retryAfter > 0 ? Math.min(retryAfter, 2) : 1) * 1000;

  await new Promise((resolve) => setTimeout(resolve, waitMs + Math.random() * 500));

  return postToResend(url, body, retries - 1);
}

/** One message as Resend's API takes it, attachments aside. */
function messageBody(input: SendEmailInput, from: string, replyTo: string | null | undefined) {
  return {
    from,
    to: Array.isArray(input.to) ? input.to : [input.to],
    subject: input.subject,
    html: input.unsubscribe
      ? withUnsubscribeLine(input.html, input.unsubscribe.pageUrl)
      : input.html,
    ...(input.unsubscribe
      ? {
          headers: {
            "List-Unsubscribe": `<${input.unsubscribe.oneClickUrl}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          },
        }
      : {}),
    ...(replyTo ? { reply_to: replyTo } : {}),
  };
}

export type SendEmailResult =
  | { sent: true; id: string }
  | { sent: false; reason: "not_configured" | "send_failed"; detail?: string };

/**
 * Sends a transactional email through Resend (docs/EMAIL_SYSTEM.md).
 *
 * The `From` header is built per send from the platform owner's configured
 * identity and the message's category, so `billing@` and `alert@` mail carries
 * the right sender without any call site knowing how the address is assembled.
 *
 * Never throws: callers must not fail a business flow because email delivery
 * failed. Failures are logged and reported in the result so callers can
 * surface/queue them if needed. With no `RESEND_API_KEY` (local dev), the email
 * is logged instead of sent.
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const category = input.category ?? DEFAULT_EMAIL_CATEGORY;
  const identity = await resolveEmailIdentity();
  const from = fromHeaderFor(category, identity);
  const replyTo = input.replyTo ?? replyToFor(category, identity);

  if (!apiKey || !from) {
    console.info(
      JSON.stringify({
        level: "info",
        action: "email_skipped",
        category,
        message: "Resend not configured (RESEND_API_KEY / EMAIL_DOMAIN); email not sent.",
        subject: input.subject,
        to: input.to,
      }),
    );
    return { sent: false, reason: "not_configured" };
  }

  try {
    const response = await postToResend(RESEND_ENDPOINT, {
      ...messageBody(input, from, replyTo),
      ...(input.attachments?.length
        ? {
            attachments: input.attachments.map((attachment) => ({
              content: Buffer.from(attachment.content).toString("base64"),
              filename: attachment.filename,
            })),
          }
        : {}),
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error(
        JSON.stringify({
          level: "error",
          action: "email_send_failed",
          category,
          from,
          message: `Resend returned ${response.status}`,
          subject: input.subject,
        }),
      );
      return { sent: false, reason: "send_failed", detail };
    }

    const payload = (await response.json()) as { id?: string };
    console.info(
      JSON.stringify({
        level: "info",
        action: "email_sent",
        category,
        from,
        message: "Email dispatched via Resend.",
        subject: input.subject,
        emailId: payload.id ?? null,
      }),
    );
    return { sent: true, id: payload.id ?? "" };
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        action: "email_send_failed",
        category,
        message: error instanceof Error ? error.message : "Unknown email error",
        subject: input.subject,
      }),
    );
    return {
      sent: false,
      reason: "send_failed",
      detail: error instanceof Error ? error.message : undefined,
    };
  }
}

/**
 * Up to a hundred emails per Resend call (`/emails/batch`), for a job that mails
 * a page of people at once — one request per message pushed a run of reminders
 * past the team's per-second limit. One result per input, in order, like
 * `sendEmail`, and never throws. No attachments: the batch endpoint takes none.
 */
export async function sendEmailBatch(
  inputs: Array<Omit<SendEmailInput, "attachments">>,
): Promise<SendEmailResult[]> {
  if (inputs.length === 0) {
    return [];
  }

  const identity = await resolveEmailIdentity();
  const results: SendEmailResult[] = [];

  for (let start = 0; start < inputs.length; start += BATCH_LIMIT) {
    const slice = inputs.slice(start, start + BATCH_LIMIT);
    const messages = slice.map((input) => {
      const category = input.category ?? DEFAULT_EMAIL_CATEGORY;
      const from = fromHeaderFor(category, identity);

      return from
        ? messageBody(input, from, input.replyTo ?? replyToFor(category, identity))
        : null;
    });

    if (!process.env.RESEND_API_KEY || messages.some((message) => !message)) {
      console.info(
        JSON.stringify({
          level: "info",
          action: "email_skipped",
          count: slice.length,
          message: "Resend not configured (RESEND_API_KEY / EMAIL_DOMAIN); batch not sent.",
        }),
      );
      results.push(...slice.map(() => ({ sent: false as const, reason: "not_configured" as const })));
      continue;
    }

    try {
      const response = await postToResend(RESEND_BATCH_ENDPOINT, messages);

      if (!response.ok) {
        const detail = await response.text();

        console.error(
          JSON.stringify({
            level: "error",
            action: "email_batch_failed",
            count: slice.length,
            message: `Resend returned ${response.status}`,
          }),
        );
        results.push(
          ...slice.map(() => ({ sent: false as const, reason: "send_failed" as const, detail })),
        );
        continue;
      }

      const payload = (await response.json()) as { data?: Array<{ id?: string }> };

      console.info(
        JSON.stringify({
          level: "info",
          action: "email_batch_sent",
          count: slice.length,
          message: "Email batch dispatched via Resend.",
        }),
      );
      results.push(
        ...slice.map((_, index) => ({ sent: true as const, id: payload.data?.[index]?.id ?? "" })),
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : undefined;

      console.error(
        JSON.stringify({
          level: "error",
          action: "email_batch_failed",
          count: slice.length,
          message: detail ?? "Unknown email error",
        }),
      );
      results.push(
        ...slice.map(() => ({ sent: false as const, reason: "send_failed" as const, detail })),
      );
    }
  }

  return results;
}
