import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  exists: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ connectToDatabase: vi.fn() }));
vi.mock("@hostel/db/models/EmailPreference", () => ({
  EmailPreferenceModel: { exists: mocks.exists },
}));
vi.mock("@hostel/shared/email/sender", () => ({ sendEmail: mocks.sendEmail }));

import {
  emailFromPreferenceToken,
  emailPreferenceToken,
  mutedAfterForm,
} from "@/modules/notifications/email-preference.service";
import { EMAIL_TOPICS } from "@/lib/notifications/email-topics";
import { sendNotificationEmail } from "@/modules/residents/resident-notify";
import { UNSUBSCRIBE_SLOT } from "@hostel/shared/email/templates/layout";

const { withUnsubscribeLine } =
  await vi.importActual<typeof import("@hostel/shared/email/sender")>(
    "@hostel/shared/email/sender",
  );

beforeEach(() => {
  vi.clearAllMocks();
  mocks.exists.mockResolvedValue(null);
  mocks.sendEmail.mockResolvedValue({ id: "e1", sent: true });
});

describe("the unsubscribe token", () => {
  it("names the address it was made for, lower-cased", () => {
    expect(emailFromPreferenceToken(emailPreferenceToken(" Ram@Example.test "))).toBe(
      "ram@example.test",
    );
  });

  it("refuses a token pointed at someone else's address", () => {
    const [, signature] = emailPreferenceToken("ram@example.test").split(".");
    const forged = `${Buffer.from("sita@example.test").toString("base64url")}.${signature}`;

    expect(emailFromPreferenceToken(forged)).toBeNull();
    expect(emailFromPreferenceToken("junk")).toBeNull();
    expect(emailFromPreferenceToken(undefined)).toBeNull();
  });
});

describe("the topics", () => {
  it("are the same list in the app's Settings screen", async () => {
    const app = await import("../../../../mobile/src/lib/notification-preferences");

    expect(app.EMAIL_TOPICS).toEqual(EMAIL_TOPICS);
  });
});

describe("the preferences form", () => {
  it("follows the boxes it showed and leaves the other topics alone", () => {
    expect(
      mutedAfterForm(
        ["NOTICES", "ATTENDANCE_ALERTS"],
        ["RENT_REMINDERS", "NOTICES", "COMPLAINT_UPDATES"],
        ["NOTICES", "COMPLAINT_UPDATES"],
      ),
    ).toEqual(["ATTENDANCE_ALERTS", "RENT_REMINDERS"]);
  });
});

describe("sending optional mail", () => {
  const mail = { action: "test", html: "<p>Hi</p>", subject: "Hi", to: "ram@example.test" };

  it("skips an address that turned the topic off", async () => {
    mocks.exists.mockResolvedValue({ _id: "x" });

    expect(await sendNotificationEmail({ ...mail, topic: "NOTICES" })).toBe(false);
    expect(mocks.exists).toHaveBeenCalledWith({
      email: "ram@example.test",
      mutedTopics: "NOTICES",
    });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("sends the rest with an unsubscribe link for that topic", async () => {
    expect(await sendNotificationEmail({ ...mail, topic: "NOTICES" })).toBe(true);

    const { unsubscribe } = mocks.sendEmail.mock.calls[0]![0];
    expect(unsubscribe.pageUrl).toMatch(/\/email-preferences\?token=.+&topic=NOTICES$/);
    expect(unsubscribe.oneClickUrl).toMatch(
      /\/api\/v1\/email-preferences\/unsubscribe\?token=.+&topic=NOTICES$/,
    );
  });

  it("never gates or labels mail sent without a topic", async () => {
    await sendNotificationEmail(mail);

    expect(mocks.exists).not.toHaveBeenCalled();
    expect(mocks.sendEmail.mock.calls[0]![0].unsubscribe).toBeUndefined();
  });

  it("sends when the preference lookup fails", async () => {
    mocks.exists.mockRejectedValue(new Error("db down"));

    expect(await sendNotificationEmail({ ...mail, topic: "RENT_REMINDERS" })).toBe(true);
  });
});

describe("the footer line", () => {
  const url = "https://example.test/email-preferences?token=a.b&topic=NOTICES";

  it("goes in the layout's slot, with the ampersand escaped", () => {
    const html = withUnsubscribeLine(`<td>footer${UNSUBSCRIBE_SLOT}</td>`, url);

    expect(html).toContain('<td>footer<br><a href="https://example.test/email-preferences?token=a.b&amp;topic=NOTICES"');
    expect(html).not.toContain(UNSUBSCRIBE_SLOT);
  });

  it("is appended to a bare fragment", () => {
    expect(withUnsubscribeLine("<p>2 overdue</p>", url)).toMatch(/^<p>2 overdue<\/p><p .+Unsubscribe/);
  });
});
