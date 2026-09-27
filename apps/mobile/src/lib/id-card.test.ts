import { describe, expect, it } from "vitest";

import {
  buildIdCard,
  CARD_COLORS,
  draftFromProfile,
  emptyIdentityDraft,
  hasIdCard,
  hasIdentityErrors,
  firstIncompleteIdentityStep,
  idCardNoun,
  idCardTypeForAccount,
  IDENTITY_STEP_FIELDS,
  IDENTITY_STEPS,
  identityStepComplete,
  type IdentityDraft,
  toProfileInput,
  validateIdentity,
  validateIdentityStep,
} from "@/lib/id-card";
import type { Identity, IdentityProfile } from "@/lib/identity-api";

function identity(overrides: Partial<Identity> = {}): Identity {
  return {
    accountEmail: "sita@example.com",
    accountName: "Sita Sharma",
    cardRole: null,
    cardType: "RESIDENT",
    hasPhoto: false,
    hasProfile: true,
    hasSignatureImage: false,
    lastSharedAt: null,
    photoUpdatedAt: null,
    residentId: "HH-4K7M-9XQ2",
    shareCount: 0,
    shareUrl: "https://softmato.com/resident-id/HH-4K7M-9XQ2",
    sharingEnabled: true,
    signatureUpdatedAt: null,
    updatedAt: "2026-08-16T10:00:00.000Z",
    ...overrides,
  };
}

function profile(overrides: Partial<IdentityProfile> = {}): IdentityProfile {
  return {
    bloodGroup: "B+",
    dietaryPreference: "VEG",
    fullName: "Sita Kumari Sharma",
    gender: "FEMALE",
    guardianName: "Ram Sharma",
    guardianPhone: "9812345678",
    guardianRelation: "Father",
    interests: [],
    occupation: "STUDENT",
    primaryEmail: "sita.sharma@example.com",
    primaryPhone: "9800011122",
    signature: "M10 10L20 20L30 30L40 40M100 50L110 60L120 70L130 80",
    ...overrides,
  };
}

/** A draft that passes, so each case can break exactly one thing. */
function validDraft(overrides: Partial<IdentityDraft> = {}): IdentityDraft {
  return {
    ...emptyIdentityDraft(),
    city: "Kathmandu",
    dateOfBirth: "2004-03-02",
    fullName: "Sita Sharma",
    gender: "FEMALE",
    guardianName: "Ram Sharma",
    guardianPhone: "9812345678",
    guardianRelation: "Father",
    permanentAddress: "Ward 5, Tinkune",
    primaryEmail: "sita@example.com",
    primaryPhone: "9800011122",
    province: "Bagmati",
    signature: "M10 10L20 20L30 30L40 40M100 50L110 60L120 70L130 80",
    ...overrides,
  };
}

describe("buildIdCard", () => {
  /*
   * `UNKNOWN` is `bloodGroupSchema`'s default, not an answer. A paramedic reading
   * it off a card cannot tell it from one, so it prints as a blank like any other
   * missing field.
   */
  it("never prints UNKNOWN as a blood group", () => {
    const card = buildIdCard(identity(), profile({ bloodGroup: "UNKNOWN" }));

    expect(card.rows).toContainEqual(["BLOOD", "—"]);
  });

  it("prints a real blood group", () => {
    expect(buildIdCard(identity(), profile()).rows).toContainEqual(["BLOOD", "B+"]);
  });

  it("lays the front rows out in the web's order", () => {
    const card = buildIdCard(identity(), profile({ dateOfBirth: "2004-03-02" }));

    expect(card.rows.map(([label]) => label)).toEqual([
      "ID NO",
      "DOB",
      "BLOOD",
      "PHONE",
      "E-MAIL",
    ]);
  });

  /*
   * `new Date("2004-03-02")` is midnight **UTC**. Reading it with the local
   * getters prints 1 March on every phone west of Greenwich — and unlike the
   * instants `lib/format.ts` handles, a date of birth has no timezone to shift.
   */
  it("reads a plain calendar date without shifting it", () => {
    const card = buildIdCard(identity(), profile({ dateOfBirth: "2004-03-02" }));

    expect(card.rows).toContainEqual(["DOB", "2 Mar 2004"]);
  });

  it("falls back to the account for a card with no profile yet", () => {
    const card = buildIdCard(identity({ hasProfile: false }), null);

    expect(card.fullName).toBe("Sita Sharma");
    expect(card.rows).toContainEqual(["E-MAIL", "sita@example.com"]);
  });

  /* Role resolution, in the web's precedence order. */
  it("prefers a platform cardRole over anything on the profile", () => {
    const card = buildIdCard(
      identity({ cardRole: "Hostel Owner", cardType: "HOSTEL_OWNER" }),
      profile({ courseOrDesignation: "BSc CSIT", institution: "Tribhuvan" }),
    );

    expect(card.role).toBe("Hostel Owner");
  });

  it("falls through course → institution → occupation", () => {
    expect(
      buildIdCard(identity(), profile({ courseOrDesignation: "BSc CSIT" })).role,
    ).toBe("BSc CSIT");
    expect(buildIdCard(identity(), profile({ institution: "Tribhuvan" })).role).toBe(
      "Tribhuvan",
    );
    expect(buildIdCard(identity(), profile()).role).toBe("Student");
  });

  it("renders the variant the server says, not always the resident one", () => {
    const owner = buildIdCard(identity({ cardType: "HOSTEL_OWNER" }), profile());

    expect(owner.idLabel).toBe("OWNER ID");
    expect(owner.title).toBe("HOSTEL OWNER IDENTITY CARD");
    expect(owner.accent).not.toBe(CARD_COLORS.accent);

    const provider = buildIdCard(identity({ cardType: "SERVICE_PROVIDER" }), profile());

    expect(provider.idLabel).toBe("PROVIDER ID");
    expect(provider.backBullets[2]).toContain("provider mobile app");
  });

  it("dates the card from the profile's last write", () => {
    expect(buildIdCard(identity(), profile()).issuedOn).toBe("16 Aug 2026");
  });

  it("falls back to today when nothing has been written yet", () => {
    const card = buildIdCard(
      identity({ hasProfile: false, updatedAt: null }),
      null,
      new Date("2026-08-17T10:00:00.000Z"),
    );

    expect(card.issuedOn).toBe("17 Aug 2026");
  });
});

describe("hasIdCard", () => {
  it("needs both a saved profile and a minted id", () => {
    expect(hasIdCard(identity())).toBe(true);
    expect(hasIdCard(identity({ hasProfile: false }))).toBe(false);
    expect(hasIdCard(identity({ residentId: null }))).toBe(false);
  });
});

describe("idCardNoun", () => {
  it("names each variant in prose", () => {
    expect(idCardNoun("RESIDENT")).toBe("resident");
    expect(idCardNoun("HOSTEL_OWNER")).toBe("hostel owner");
    expect(idCardNoun("SERVICE_PROVIDER")).toBe("service provider");
  });
});

describe("idCardTypeForAccount", () => {
  it("mirrors resolvePlatformIdCard's order of precedence", () => {
    // A hostel admin who also holds an approved provider record is an owner:
    // the server checks the role first and returns before it looks for one.
    expect(
      idCardTypeForAccount({ isServiceProvider: true, role: "HOSTEL_ADMIN" }),
    ).toBe("HOSTEL_OWNER");
    expect(idCardTypeForAccount({ isServiceProvider: true, role: "PUBLIC" })).toBe(
      "SERVICE_PROVIDER",
    );
    expect(idCardTypeForAccount({ role: "PUBLIC" })).toBe("RESIDENT");
    expect(idCardTypeForAccount({ role: "RESIDENT" })).toBe("RESIDENT");
  });
});

describe("validateIdentity", () => {
  it("passes a draft with only the required fields", () => {
    expect(hasIdentityErrors(validateIdentity(validDraft()))).toBe(false);
  });

  it("names every required field on an empty draft", () => {
    const errors = validateIdentity(emptyIdentityDraft());

    expect(Object.keys(errors).sort()).toEqual([
      "city",
      "dateOfBirth",
      "fullName",
      "gender",
      "guardianName",
      "guardianPhone",
      "guardianRelation",
      "permanentAddress",
      "primaryEmail",
      "primaryPhone",
      "province",
      "signature",
    ]);
  });

  /*
   * The server's `blankToUndefined` turns `""` into "not provided" for every
   * optional field, so a form full of untouched inputs must not fail. This is the
   * property that makes a 30-field form usable.
   */
  it("ignores blank optional fields entirely", () => {
    const errors = validateIdentity(
      validDraft({
        alternatePhone: "",
        backupEmail: "",
        medicalNotes: "",
        secondGuardianPhone: "",
      }),
    );

    expect(hasIdentityErrors(errors)).toBe(false);
  });

  it("requires a date of birth, well-formed and in the past", () => {
    expect(validateIdentity(validDraft({ dateOfBirth: "" })).dateOfBirth).toBeTruthy();
    expect(validateIdentity(validDraft({ dateOfBirth: "2999-01-01" })).dateOfBirth)
      .toBeTruthy();
    expect(validateIdentity(validDraft({ dateOfBirth: "02/03/2004" })).dateOfBirth)
      .toContain("YYYY-MM-DD");
  });

  it("validates an optional field once it is filled", () => {
    expect(validateIdentity(validDraft({ backupEmail: "nope" })).backupEmail).toBeTruthy();
    expect(validateIdentity(validDraft({ alternatePhone: "123" })).alternatePhone)
      .toBeTruthy();
  });

  // The server enforces this with a `.refine`, which fails the whole save rather
  // than one field — so catching it here is what puts the message on the input.
  it("refuses a backup email equal to the main one, case-insensitively", () => {
    expect(
      validateIdentity(
        validDraft({ backupEmail: "SITA@example.com", primaryEmail: "sita@example.com" }),
      ).backupEmail,
    ).toContain("different");
  });

  it("holds the server's phone length bounds", () => {
    expect(validateIdentity(validDraft({ primaryPhone: "981234" })).primaryPhone)
      .toContain("7");
    expect(
      validateIdentity(validDraft({ guardianPhone: "9".repeat(25) })).guardianPhone,
    ).toBeTruthy();
  });

  // The main phone is checked for another account using it, so it has to be a number.
  it("wants digits for the main phone, in the ways people type them", () => {
    expect(validateIdentity(validDraft({ primaryPhone: "call me maybe" })).primaryPhone)
      .toBeTruthy();
    expect(validateIdentity(validDraft({ primaryPhone: "+977 981-234-5678" })).primaryPhone)
      .toBeUndefined();
    expect(validateIdentity(validDraft({ primaryPhone: "01-4412345" })).primaryPhone)
      .toBeUndefined();
  });
});

describe("toProfileInput", () => {
  /*
   * The point of the conversion. The server *would* coerce `""` away, but sending
   * it means a required `primaryEmail: ""` reaches `z.string().email()` and an
   * `optionalEnum` depends on a preprocessing step written for HTML forms.
   */
  it("omits blank optional fields rather than sending empty strings", () => {
    const payload = toProfileInput(validDraft());

    expect("backupEmail" in payload).toBe(false);
    expect("governmentIdType" in payload).toBe(false);
    expect("secondGuardianName" in payload).toBe(false);
  });

  it("keeps every filled field, trimmed", () => {
    const payload = toProfileInput(
      validDraft({ city: "  Lalitpur  ", dateOfBirth: "2004-03-02" }),
    );

    expect(payload.city).toBe("Lalitpur");
    expect(payload.dateOfBirth).toBe("2004-03-02");
  });

  it("lowercases the email, as the schema does", () => {
    expect(toProfileInput(validDraft({ primaryEmail: "Sita@Example.COM" })).primaryEmail)
      .toBe("sita@example.com");
  });

  it("de-duplicates and strips blanks from interests", () => {
    expect(
      toProfileInput(validDraft({ interests: ["Football", " Football ", "", "Music"] }))
        .interests,
    ).toEqual(["Football", "Music"]);
  });

  it("always sends the three defaulted enums", () => {
    const payload = toProfileInput(validDraft());

    expect(payload.bloodGroup).toBe("UNKNOWN");
    expect(payload.occupation).toBe("STUDENT");
    expect(payload.dietaryPreference).toBe("NO_PREFERENCE");
  });
});

describe("draftFromProfile", () => {
  it("round-trips a saved profile back into the form", () => {
    const saved = profile({
      city: "Lalitpur",
      dateOfBirth: "2004-03-02",
      permanentAddress: "Ward 3, Pulchowk",
      province: "Bagmati",
    });
    const draft = draftFromProfile(saved);

    expect(draft.fullName).toBe(saved.fullName);
    expect(draft.city).toBe("Lalitpur");
    expect(draft.gender).toBe("FEMALE");
    expect(draft.bloodGroup).toBe("B+");
    expect(hasIdentityErrors(validateIdentity(draft))).toBe(false);
  });

  // An edit must not resurrect a field the holder cleared, and must not put
  // `undefined` into a `TextInput`, which React Native renders as uncontrolled.
  it("turns every absent optional field into an empty string", () => {
    const draft = draftFromProfile(profile());

    expect(draft.dateOfBirth).toBe("");
    expect(draft.governmentIdType).toBe("");
    expect(draft.medicalNotes).toBe("");
  });

  it("returns a blank draft for an account with no profile", () => {
    expect(draftFromProfile(null)).toEqual(emptyIdentityDraft());
  });

  /*
   * `age` is derived server-side from `dateOfBirth` and is not part of
   * `residentProfileDataSchema` — sending it back would be an unknown key.
   */
  it("does not carry the derived age into the payload", () => {
    const payload = toProfileInput(draftFromProfile(profile({ age: 21 })));

    expect("age" in payload).toBe(false);
  });
});

const NO_ASSETS = { hasPhoto: false, hasSignatureImage: false };
const BOTH_ASSETS = { hasPhoto: true, hasSignatureImage: true };

describe("the step split", () => {
  /*
   * The split is a filter over `validateIdentity`, not a second copy of the
   * rules — so the thing worth asserting is that the filter loses nothing. A
   * field owned by no step is a field whose error can never be shown, and the
   * user meets that as a Create button that refuses with no red anywhere.
   */
  it("gives every rule somewhere to be displayed", () => {
    const owned = new Set(Object.values(IDENTITY_STEP_FIELDS).flat());
    const everyError = validateIdentity(emptyIdentityDraft());

    for (const field of Object.keys(everyError)) {
      expect(owned.has(field as keyof IdentityDraft)).toBe(true);
    }
  });

  it("claims each field exactly once", () => {
    const seen = Object.values(IDENTITY_STEP_FIELDS).flat();

    expect(seen.length).toBe(new Set(seen).size);
  });

  it("flags only the step being left", () => {
    const blank = emptyIdentityDraft();

    expect(Object.keys(validateIdentityStep("about", blank))).toEqual([
      "fullName",
      "dateOfBirth",
      "gender",
    ]);
    // The guardian is required too, and is three screens away — a Continue on
    // About you that turned the Guardian fields red would be pointing at a
    // screen the user has not seen.
    expect(validateIdentityStep("about", blank).guardianName).toBeUndefined();
  });

  it("counts a photographed signature as a signed card", () => {
    const drawn = validDraft();
    const photographed = validDraft({
      signature: "",
      signatureImageUri: "file:///tmp/signature.jpg",
    });

    expect(identityStepComplete("signature", drawn, NO_ASSETS)).toBe(true);
    expect(identityStepComplete("signature", photographed, NO_ASSETS)).toBe(true);
    expect(
      identityStepComplete("signature", validDraft({ signature: "" }), NO_ASSETS),
    ).toBe(false);
    // Already on the record from a previous save, with nothing re-sent.
    expect(
      identityStepComplete("signature", validDraft({ signature: "" }), BOTH_ASSETS),
    ).toBe(true);
  });

  it("treats the photo as an upload rather than as a draft field", () => {
    expect(identityStepComplete("photo", validDraft(), NO_ASSETS)).toBe(false);
    expect(identityStepComplete("photo", validDraft(), BOTH_ASSETS)).toBe(true);
  });

  it("sends the user to the first thing that is actually missing", () => {
    expect(firstIncompleteIdentityStep(emptyIdentityDraft(), NO_ASSETS)).toBe("about");
    expect(firstIncompleteIdentityStep(validDraft(), NO_ASSETS)).toBe("photo");
    expect(firstIncompleteIdentityStep(validDraft(), BOTH_ASSETS)).toBeNull();
  });

  it("ends on Review, which owns no fields of its own", () => {
    expect(IDENTITY_STEPS.at(-1)?.key).toBe("review");
    expect(IDENTITY_STEP_FIELDS.review).toEqual([]);
  });
});

describe("toProfileInput with a photographed signature", () => {
  it("omits the stroke field entirely rather than sending an empty one", () => {
    const input = toProfileInput(
      validDraft({ signature: "", signatureImageUri: "file:///tmp/signature.jpg" }),
    );

    // `""` would fail the server's stroke grammar before it ever looked at the
    // asset id sitting beside it on the envelope.
    expect("signature" in input).toBe(false);
  });

  it("still sends strokes when that is what was drawn", () => {
    expect(toProfileInput(validDraft()).signature).toContain("M10 10");
  });
});
