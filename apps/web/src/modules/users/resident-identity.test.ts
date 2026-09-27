import { describe, expect, it } from "vitest";

import { normalizeResidentId } from "@/modules/users/resident-identity.service";
import {
  residentIdentitySaveSchema,
  residentPhoneKey,
  residentProfileDataSchema,
} from "@/modules/users/resident-identity.validation";

const validProfile = {
  dateOfBirth: "2004-03-02",
  fullName: "Asha Rai",
  gender: "FEMALE",
  guardianName: "Bimala Rai",
  guardianPhone: "9800000001",
  guardianRelation: "Mother",
  primaryEmail: "Asha@Example.com",
  primaryPhone: "9800000000",
  signature: "M10 10L20 20L30 30L40 40M100 50L110 60L120 70L130 80",
};

describe("signature", () => {
  /**
   * A *missing* signature is legal here and refused a layer up.
   *
   * There are two ways to sign now — strokes in the profile, or a photograph of
   * a signature on paper, which arrives as an asset id on the save envelope
   * rather than inside the profile at all. This schema cannot see that field,
   * and neither field can see whether the record already carries one, so
   * "there has to be a signature" is `saveResidentIdentity`'s call
   * (`SIGNATURE_REQUIRED`). What stays enforced here is that anything
   * *presented* as strokes is real strokes.
   */
  it("allows the strokes to be absent, since they are one of two ways to sign", () => {
    const without = { ...validProfile } as Partial<typeof validProfile>;
    delete without.signature;

    expect(residentProfileDataSchema.safeParse(without).success).toBe(true);
  });

  it("rejects a blank or out-of-box signature", () => {
    expect(
      residentProfileDataSchema.safeParse({ ...validProfile, signature: "M1 1L2 2" }).success,
    ).toBe(false);
    expect(
      residentProfileDataSchema.safeParse({
        ...validProfile,
        signature: "M10 10L20 20L30 30L40 40M100 50L110 60L120 70L130 900",
      }).success,
    ).toBe(false);
  });

  it("rejects anything but M/L and integers", () => {
    expect(
      residentProfileDataSchema.safeParse({
        ...validProfile,
        signature: `${validProfile.signature}<script>`,
      }).success,
    ).toBe(false);
  });
});

describe("normalizeResidentId", () => {
  it("accepts the canonical format", () => {
    expect(normalizeResidentId("HH-4K7M-9XQ2")).toBe("HH-4K7M-9XQ2");
  });

  it("repairs what a warden actually types", () => {
    // Lowercase, missing dashes, stray spaces — all the same person.
    expect(normalizeResidentId("hh4k7m9xq2")).toBe("HH-4K7M-9XQ2");
    expect(normalizeResidentId("  hh 4k7m 9xq2 ")).toBe("HH-4K7M-9XQ2");
    expect(normalizeResidentId("HH_4K7M_9XQ2")).toBe("HH-4K7M-9XQ2");
  });

  it("extracts the id from a scanned share URL", () => {
    expect(normalizeResidentId("https://hostelpalika.test/resident-id/HH-4K7M-9XQ2")).toBe(
      "HH-4K7M-9XQ2",
    );
    expect(
      normalizeResidentId("https://hostelpalika.test/resident-id/HH-4K7M-9XQ2?utm=qr"),
    ).toBe("HH-4K7M-9XQ2");
  });

  it("rejects anything that is not an id", () => {
    expect(normalizeResidentId("9800000000")).toBeNull();
    expect(normalizeResidentId("HH-4K7M")).toBeNull();
    expect(normalizeResidentId("XX-4K7M-9XQ2")).toBeNull();
    expect(normalizeResidentId("")).toBeNull();
  });
});

describe("residentProfileDataSchema", () => {
  it("normalizes emails and applies sensible defaults", () => {
    const parsed = residentProfileDataSchema.parse(validProfile);

    expect(parsed.primaryEmail).toBe("asha@example.com");
    expect(parsed.bloodGroup).toBe("UNKNOWN");
    expect(parsed.occupation).toBe("STUDENT");
    expect(parsed.dietaryPreference).toBe("NO_PREFERENCE");
    expect(parsed.interests).toEqual([]);
  });

  it("caps the user at two distinct emails", () => {
    expect(() =>
      residentProfileDataSchema.parse({
        ...validProfile,
        backupEmail: "asha@example.com",
      }),
    ).toThrow();

    expect(
      residentProfileDataSchema.parse({
        ...validProfile,
        backupEmail: "asha.backup@example.com",
      }).backupEmail,
    ).toBe("asha.backup@example.com");
  });

  it("wants a number for the main phone, however it is typed", () => {
    expect(() =>
      residentProfileDataSchema.parse({ ...validProfile, primaryPhone: "call me maybe" }),
    ).toThrow();

    for (const primaryPhone of ["+977 981-234-5678", "(01) 4412345", "+91 98123 45678"]) {
      expect(
        residentProfileDataSchema.parse({ ...validProfile, primaryPhone }).primaryPhone,
      ).toBe(primaryPhone);
    }
  });

  it("keys one Nepali number the same with or without +977, and no other country", () => {
    expect(residentPhoneKey("+977 981-234-5678")).toBe("9812345678");
    expect(residentPhoneKey("9812345678")).toBe("9812345678");
    expect(residentPhoneKey("+91 98123 45678")).toBe("919812345678");
  });

  it("treats blank optional fields as absent", () => {
    const parsed = residentProfileDataSchema.parse({
      ...validProfile,
      backupEmail: "",
      medicalNotes: "",
    });

    expect(parsed.backupEmail).toBeUndefined();
    expect(parsed.medicalNotes).toBeUndefined();
  });

  it("requires a date of birth, in the past", () => {
    for (const dateOfBirth of [undefined, "", "   ", "2999-01-01"]) {
      expect(
        residentProfileDataSchema.safeParse({ ...validProfile, dateOfBirth }).success,
      ).toBe(false);
    }
  });

  it("de-duplicates interests", () => {
    expect(
      residentProfileDataSchema.parse({
        ...validProfile,
        interests: ["football", "football", "music"],
      }).interests,
    ).toEqual(["football", "music"]);
  });

  it("requires a reachable guardian", () => {
    expect(() =>
      residentProfileDataSchema.parse({
        ...validProfile,
        guardianPhone: undefined,
      }),
    ).toThrow();
  });
});

describe("blank form fields", () => {
  /*
   * Regression: an HTML form submits an untouched field as "", not as a missing
   * key. A `<select>` placeholder with value="" used to fail the whole
   * submission with an opaque 422 that named no field.
   */
  const blankable = [
    "alternatePhone",
    "backupEmail",
    "bloodGroup",
    "budgetRange",
    "city",
    "courseOrDesignation",
    "dietaryPreference",
    "emergencyContactName",
    "emergencyContactPhone",
    "emergencyContactRelation",
    "governmentIdNumber",
    "governmentIdType",
    "guardianEmail",
    "institution",
    "medicalNotes",
    "occupation",
    "permanentAddress",
    "province",
    "secondGuardianEmail",
    "secondGuardianName",
    "secondGuardianPhone",
    "secondGuardianRelation",
  ] as const;

  it.each(blankable)("accepts %s as an empty string", (field) => {
    const result = residentProfileDataSchema.safeParse({
      ...validProfile,
      [field]: "",
    });

    expect(result.success).toBe(true);
  });

  it("accepts every optional blank at once", () => {
    const allBlank = Object.fromEntries(blankable.map((field) => [field, ""]));
    const parsed = residentProfileDataSchema.parse({ ...validProfile, ...allBlank });

    // Blanks become absent, and the defaulted selects fall back rather than fail.
    expect(parsed.governmentIdType).toBeUndefined();
    expect(parsed.backupEmail).toBeUndefined();
    expect(parsed.bloodGroup).toBe("UNKNOWN");
    expect(parsed.occupation).toBe("STUDENT");
    expect(parsed.dietaryPreference).toBe("NO_PREFERENCE");
  });

  it("accepts whitespace-only input the same way", () => {
    const parsed = residentProfileDataSchema.parse({
      ...validProfile,
      medicalNotes: "   ",
      secondGuardianName: "  ",
    });

    expect(parsed.medicalNotes).toBeUndefined();
    expect(parsed.secondGuardianName).toBeUndefined();
  });

  it("reports the failing field by its full path, not just the parent", () => {
    /*
     * `flatten()` buckets a nested failure under the top-level key, which reads
     * as "profile" and points the user at nothing. The API sends `issues` with
     * the dotted path so the form can name the actual input.
     */
    const result = residentIdentitySaveSchema.safeParse({
      profile: { ...validProfile, backupEmail: validProfile.primaryEmail },
      sharingEnabled: true,
    });

    expect(result.success).toBe(false);

    const paths = result.error!.issues.map((issue) => issue.path.join("."));
    expect(paths).toContain("profile.backupEmail");

    // The leaf segment is what the client maps to a human label.
    expect(paths[0]!.split(".").pop()).toBe("backupEmail");
  });

  it("still rejects a genuinely malformed value", () => {
    expect(
      residentProfileDataSchema.safeParse({ ...validProfile, backupEmail: "nope" })
        .success,
    ).toBe(false);
    expect(
      residentProfileDataSchema.safeParse({ ...validProfile, dateOfBirth: "12/03/2001" })
        .success,
    ).toBe(false);
    expect(
      residentProfileDataSchema.safeParse({ ...validProfile, governmentIdType: "PAN" })
        .success,
    ).toBe(false);
  });
});
