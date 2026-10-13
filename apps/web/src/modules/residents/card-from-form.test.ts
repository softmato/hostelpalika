import { describe, expect, it } from "vitest";

import { cardGap } from "@/modules/residents/admission-form.service";
import { cardFromDetails, residentDetailsSchema } from "@/modules/residents/resident-details";
import { residentProfileDataSchema } from "@/modules/users/resident-identity.validation";

const SIGNATURE = "M10 10L20 20L30 30L40 40L50 50L60 60L70 70L80 80";

const form = residentDetailsSchema.parse({
  citizenshipNo: "12-34-567",
  dateOfBirth: "2004-05-01",
  district: "Kaski",
  family: [
    { name: "Hari Thapa", relation: "Father" },
    { name: "Sita Thapa", phone: "9800000001", relation: "Mother" },
  ],
  food: "VEG",
  gender: "MALE",
  localGuardian: { name: "Ram Thapa", phone: "9800000002", relation: "Uncle" },
  municipality: "Pokhara",
  signature: SIGNATURE,
});

const who = { email: "ram@gmail.com", firstName: "Ram", lastName: "Thapa", phone: "9812345678", residentType: "STUDENT" };

describe("the admission form as an ID card", () => {
  it("makes a card the card schema accepts, guardian = first of the family with a phone", () => {
    const card = residentProfileDataSchema.parse(cardFromDetails(form, who));

    expect(card).toMatchObject({
      city: "Pokhara",
      fullName: "Ram Thapa",
      governmentIdType: "CITIZENSHIP",
      guardianName: "Sita Thapa",
      guardianPhone: "9800000001",
      secondGuardianName: "Hari Thapa",
      emergencyContactName: "Ram Thapa",
      signature: SIGNATURE,
    });
  });

  it("is not a card without a guardian anyone can ring", () => {
    const noPhones = { ...form, family: [{ name: "Hari Thapa", relation: "Father" }] };

    expect(residentProfileDataSchema.safeParse(cardFromDetails(noPhones, who)).success).toBe(false);
  });

  it("the person's own form asks for what the card prints", () => {
    expect(cardGap(form)).toBeNull();
    expect(cardGap({ ...form, gender: undefined })).toBe("Choose your gender.");
    expect(cardGap({ ...form, signature: undefined })).toBe("Sign the form.");
    expect(cardGap({ ...form, family: [{ name: "Hari Thapa", relation: "Father" }] })).toMatch(/contact number/);
  });
});
