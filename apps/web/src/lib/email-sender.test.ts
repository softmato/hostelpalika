import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_MAILBOXES, setEmailIdentityResolver } from "@hostel/shared/email/identity";
import { sendEmail, sendEmailBatch } from "@hostel/shared/email/sender";

const fetchMock = vi.fn();

function reply(status: number, body: unknown = {}) {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  setEmailIdentityResolver(async () => ({
    domain: "softmato.com",
    mailboxes: { ...DEFAULT_MAILBOXES },
    replyTo: "support@softmato.com",
    senderName: "HostelPalika",
  }));
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("sendEmail", () => {
  // A 429 used to come back as "not sent" to a caller that never looks.
  it("waits out a 429 and sends", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("", { headers: { "retry-after": "0" }, status: 429 }))
      .mockResolvedValueOnce(reply(200, { id: "email-1" }));

    await expect(
      sendEmail({ html: "<p>Hi</p>", subject: "Hi", to: "a@example.com" }),
    ).resolves.toEqual({ id: "email-1", sent: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("sendEmailBatch", () => {
  it("sends a hundred per request and answers one result per email, in order", async () => {
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const messages = JSON.parse(String(init.body)) as unknown[];

      return reply(200, { data: messages.map((_, index) => ({ id: `id-${index}` })) });
    });

    const inputs = Array.from({ length: 150 }, (_, index) => ({
      html: "<p>Due</p>",
      subject: "Fee due",
      to: `resident${index}@example.com`,
      unsubscribe: { oneClickUrl: "https://x.test/u", pageUrl: "https://x.test/p" },
    }));
    const results = await sendEmailBatch(inputs);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.resend.com/emails/batch");
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1].body))).toHaveLength(50);
    // Opt-out headers survive the batch.
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body))[0].headers).toMatchObject({
      "List-Unsubscribe": "<https://x.test/u>",
    });
    expect(results).toHaveLength(150);
    expect(results[120]).toEqual({ id: "id-20", sent: true });
  });

  it("marks a refused batch as not sent rather than throwing", async () => {
    fetchMock.mockResolvedValue(reply(422, { message: "bad" }));

    const results = await sendEmailBatch([
      { html: "<p>x</p>", subject: "x", to: "a@example.com" },
    ]);

    expect(results).toEqual([
      expect.objectContaining({ reason: "send_failed", sent: false }),
    ]);
  });
});
