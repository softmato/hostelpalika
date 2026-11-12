import { describe, expect, it } from "vitest";

import { firstOpenStep, kycChapters, kycOrder, nextOpenStep } from "./kyc-order";

// The server's own order (hostel-kyc.service.ts KYC_STEPS).
const server = ["details", "photos", "rates", "rooms", "documents", "payout", "payments", "opening", "food", "rules", "facilities", "location", "agreement"];
const steps = (done: string[] = []) => server.map((key) => ({ done: done.includes(key), key }));

describe("kyc order", () => {
  it("walks map first, room types before rooms, agreement last, nothing lost", () => {
    const order = kycOrder([...steps(), { done: false, key: "newthing" }]).map((step) => step.key);
    expect(order[0]).toBe("location");
    expect(order.indexOf("rates")).toBeLessThan(order.indexOf("rooms"));
    expect(order.at(-2)).toBe("agreement");
    expect(order.at(-1)).toBe("newthing");
    expect(order).toHaveLength(14);
    expect(kycChapters(steps()).map((chapter) => chapter.title)).toEqual(["Your hostel", "Rooms & price", "Daily life", "Money", "Verify"]);
  });

  it("continues at the first open step and skips done ones on next", () => {
    expect(firstOpenStep(steps(["location"]))).toBe("details");
    expect(nextOpenStep(steps(["facilities", "photos"]), "details")).toBe("rates");
    expect(nextOpenStep(steps(), "agreement")).toBeNull();
    expect(firstOpenStep(steps(server))).toBeNull();
  });
});
