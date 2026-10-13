import { describe, expect, it } from "vitest";

import { trialReminderMark } from "./trial-reminders.service";

describe("trialReminderMark", () => {
  it("reminds three days out and on the last day, nowhere else", () => {
    expect(trialReminderMark(5)).toBeNull();
    expect(trialReminderMark(3)).toBe(3);
    expect(trialReminderMark(1)).toBe(3);
    expect(trialReminderMark(0)).toBe(0);
  });
});
