import { describe, expect, it } from "vitest";

import {
  hostelRegistrationSchema,
  teamHostelRegistrationSchema,
} from "./hostel-registration.validation";

/**
 * The registration contract, checked where it is easiest to get wrong.
 *
 * The two things under test here are both fields that *used to be silently
 * dropped*: zod strips unknown keys, so a form could upload a categorised photo,
 * watch it succeed, and have the category never reach the database. Nothing
 * failed; the photo simply stopped being an exterior. That class of bug does not
 * announce itself, which is why it gets a test rather than a comment.
 */

const base = {
  applicant: { name: "Sita Rai", phone: "9800000000" },
  facilities: [],
  location: { area: "Baneshwor", city: "Kathmandu" },
  name: "Everest Boys Hostel",
  roomConfigurations: [
    {
      bedsPerRoom: 2,
      mealInclusion: "Included" as const,
      rooms: 6,
      roomType: "Double Sharing",
      vacantBeds: 3,
    },
  ],
  roomTypes: ["Double Sharing"],
  rules: [],
};

describe("hostelRegistrationSchema — the rate card figures", () => {
  it("retains form fees and separate attached-bathroom inventory", () => {
    const parsed = hostelRegistrationSchema.parse({ ...base, pricing: { formFee: 300 }, roomConfigurations: [...base.roomConfigurations, { ...base.roomConfigurations[0], roomType: "Double Sharing — Attached Bathroom", rooms: 2, monthlyRent: 11000 }] });
    expect(parsed.pricing?.formFee).toBe(300);
    expect(parsed.roomConfigurations).toHaveLength(2);
    expect(parsed.roomConfigurations[1]).toMatchObject({ roomType: "Double Sharing — Attached Bathroom", rooms: 2, monthlyRent: 11000 });
  });

  it.each([-1, 0.5])("rejects invalid form fee %s", (formFee) => {
    expect(hostelRegistrationSchema.safeParse({ ...base, pricing: { formFee } }).success).toBe(false);
  });
  it("keeps the deposit and the referral discount a form sends", () => {
    const parsed = hostelRegistrationSchema.parse({
      ...base,
      photos: [],
      pricing: { admissionFee: 2000 },
      referralAdmissionDiscount: 500,
      securityDeposit: 5000,
    });

    expect(parsed.securityDeposit).toBe(5000);
    expect(parsed.referralAdmissionDiscount).toBe(500);
  });

  /*
   * The same rule `feeScheduleCreateSchema` enforces, checked here because on
   * the team path the card is opened *after* the hostel is published and the
   * plan invoice is raised — a refusal at that point is a hostel that went live
   * with no rate card and nobody watching the log.
   */
  it("refuses a referral discount larger than the admission fee", () => {
    const result = hostelRegistrationSchema.safeParse({
      ...base,
      photos: [],
      pricing: { admissionFee: 2000 },
      referralAdmissionDiscount: 5000,
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path).toEqual(["referralAdmissionDiscount"]);
  });

  it("refuses a discount when no admission fee was stated at all", () => {
    const result = hostelRegistrationSchema.safeParse({
      ...base,
      photos: [],
      referralAdmissionDiscount: 500,
    });

    expect(result.success).toBe(false);
  });
});

describe("hostelRegistrationSchema — photos", () => {
  it("keeps the kind and room type a categorised upload sends", () => {
    const parsed = hostelRegistrationSchema.parse({
      ...base,
      photos: [
        { kind: "EXTERIOR", url: "/api/v1/files/6a8e766ef8a166d716953651/url" },
        { kind: "ROOM", roomType: "Double Sharing", url: "https://cdn.example.com/a.jpg" },
      ],
    });

    expect(parsed.photos[0].kind).toBe("EXTERIOR");
    expect(parsed.photos[1].roomType).toBe("Double Sharing");
  });

  it("defaults an untagged photo to INTERIOR, matching how readers resolve it", () => {
    const parsed = hostelRegistrationSchema.parse({
      ...base,
      photos: [{ url: "https://cdn.example.com/a.jpg" }],
    });

    expect(parsed.photos[0].kind).toBe("INTERIOR");
  });

  it("refuses a room photo for a room type this hostel did not submit", () => {
    const result = hostelRegistrationSchema.safeParse({
      ...base,
      photos: [{ kind: "ROOM", roomType: "4 Sharing", url: "https://cdn.example.com/a.jpg" }],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toContain("4 Sharing");
  });

  it("refuses a room photo that names no room type at all", () => {
    const result = hostelRegistrationSchema.safeParse({
      ...base,
      photos: [{ kind: "ROOM", url: "https://cdn.example.com/a.jpg" }],
    });

    expect(result.success).toBe(false);
  });

  it("leaves exterior and interior photos alone — roomType is a ROOM concern", () => {
    expect(
      hostelRegistrationSchema.safeParse({
        ...base,
        photos: [{ kind: "EXTERIOR", url: "https://cdn.example.com/a.jpg" }],
      }).success,
    ).toBe(true);
  });
});

describe("hostelRegistrationSchema — food routine", () => {
  it("accepts the same weekly payload the kitchen screen posts", () => {
    const parsed = hostelRegistrationSchema.parse({
      ...base,
      foodRoutine: {
        meals: [{ dayOfWeek: "SUNDAY", items: ["Dal Bhat"], mealType: "DINNER" }],
        timings: { DINNER: "7:30 pm" },
      },
    });

    expect(parsed.foodRoutine?.meals).toHaveLength(1);
    expect(parsed.foodRoutine?.timings.DINNER).toBe("7:30 pm");
  });

  it("is optional — the public desk does not collect one", () => {
    expect(hostelRegistrationSchema.parse(base).foodRoutine).toBeUndefined();
  });
});

describe("teamHostelRegistrationSchema", () => {
  const team = {
    ...base,
    payment: { amount: 4500, method: "SOFTMATO" as const },
    plan: { cycle: "monthly" as const, planId: "growth" },
  };

  it("carries the same photo rules as the public contract", () => {
    expect(
      teamHostelRegistrationSchema.safeParse({
        ...team,
        photos: [{ kind: "ROOM", roomType: "Nope", url: "https://cdn.example.com/a.jpg" }],
      }).success,
    ).toBe(false);
  });

  it("refuses an online payment typed in by the agent — Softmato confirms those", () => {
    expect(
      teamHostelRegistrationSchema.safeParse({
        ...team,
        payment: { amount: 4500, method: "SOFTMATO", reference: "TXN-8812" },
      }).success,
    ).toBe(false);

    expect(
      teamHostelRegistrationSchema.parse({ ...team, payment: { amount: 0, method: "SOFTMATO" } })
        .payment.method,
    ).toBe("SOFTMATO");
  });

  it("refuses cash of nothing — a hostel does not publish unpaid", () => {
    expect(
      teamHostelRegistrationSchema.safeParse({
        ...team,
        payment: { amount: 0, method: "CASH" },
      }).success,
    ).toBe(false);
  });

  it("allows part cash — the rest is owed", () => {
    expect(
      teamHostelRegistrationSchema.parse({
        ...team,
        payment: { amount: 500, method: "CASH" },
      }).payment.amount,
    ).toBe(500);
  });

  it("still requires a plan, because the plan is a step in that form", () => {
    const { plan: _plan, ...withoutPlan } = team;

    expect(teamHostelRegistrationSchema.safeParse(withoutPlan).success).toBe(false);
  });
});
