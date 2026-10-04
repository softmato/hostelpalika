import { describe, expect, it } from "vitest";

import {
  buildHostelPayload,
  capacitySummary,
  emptyHostelForm,
  emptyRoomRow,
  firstIncompleteHostelStep,
  hostelStepErrors,
  isHostelStepComplete,
  numberValue,
  RULES_TEMPLATES,
  type HostelForm,
} from "@/lib/hostel-registration";

function form(overrides: Partial<HostelForm> = {}): HostelForm {
  return {
    ...emptyHostelForm("room-1"),
    address: "Ward 4, Bagdol Marg",
    area: "Bagdol",
    description: "Quiet, close to the campus.",
    email: "owner@example.com",
    hostelName: "Green View Hostel",
    idProof: {
      claimToken: "claim-token-for-the-id-proof",
      fileAssetId: "0123456789abcdef01234561",
      fileName: "citizenship.jpg",
      url: "https://cdn.example/id.jpg",
    },
    idProofType: "Citizenship",
    ownerName: "Sita Sharma",
    ownerPhone: "9800000000",
    pin: { lat: 27.7033, lng: 85.3262 },
    rooms: [
      {
        ...emptyRoomRow("room-1", "Double Sharing"),
        bedsPerRoom: "2",
        monthlyRent: "7000",
        rooms: "10",
        vacantBeds: "3",
      },
    ],
    rulesDocument: {
      claimToken: "claim-token-for-the-house-rules",
      fileAssetId: "0123456789abcdef01234562",
      fileName: "House rules.txt",
      url: "https://cdn.example/rules.txt",
    },
    ...overrides,
  };
}

describe("hostelStepErrors", () => {
  it("reports nothing on a complete form", () => {
    const complete = form({ agreed: true });

    for (const step of ["basics", "location", "rooms", "documents", "review"] as const) {
      expect(hostelStepErrors(step, complete)).toEqual({});
    }
  });

  /**
   * Not a nice-to-have. `registerPublicHostelApplication` creates the owner
   * `User` from this address and `resolveHostelOwner` bails without one, so an
   * application filed with no email is accepted and can then never be approved.
   */
  it("requires a real owner email even though the schema calls it optional", () => {
    expect(hostelStepErrors("basics", form({ email: "" })).email).toBeDefined();
    expect(hostelStepErrors("basics", form({ email: "owner@" })).email).toBeDefined();
    expect(hostelStepErrors("basics", form()).email).toBeUndefined();
  });

  it("lets the location step finish without a map pin", () => {
    expect(hostelStepErrors("location", form({ mapLink: "", pin: null }))).toEqual({});
  });

  it("wants a room type with both counts above zero, not merely a row", () => {
    expect(
      hostelStepErrors("rooms", form({ rooms: [emptyRoomRow("room-1")] })).rooms,
    ).toBeDefined();

    expect(
      hostelStepErrors(
        "rooms",
        form({
          rooms: [{ ...emptyRoomRow("room-1"), bedsPerRoom: "0", rooms: "10" }],
        }),
      ).rooms,
    ).toBeDefined();
  });

  it("wants the ID type *and* the file — one without the other files nothing useful", () => {
    expect(hostelStepErrors("documents", form({ idProof: null })).idProof).toBeDefined();
    expect(
      hostelStepErrors("documents", form({ idProofType: "" })).idProofType,
    ).toBeDefined();
  });

  it("holds the submit until the ownership claim is ticked", () => {
    expect(hostelStepErrors("review", form({ agreed: false })).agreed).toBeDefined();
    expect(hostelStepErrors("review", form({ agreed: true }))).toEqual({});
  });
});

describe("firstIncompleteHostelStep", () => {
  it("is null on a submittable form", () => {
    expect(firstIncompleteHostelStep(form({ agreed: true }))).toBeNull();
  });

  it("returns the earliest step with a problem", () => {
    expect(firstIncompleteHostelStep(form({ address: "", hostelName: "" }))).toBe(
      "basics",
    );
  });

  it("catches a documents gap from the review screen", () => {
    expect(firstIncompleteHostelStep(form({ agreed: true, rulesDocument: null }))).toBe(
      "documents",
    );
  });
});

describe("numberValue", () => {
  it("is undefined for blank, so an unstated fee is not submitted as free", () => {
    expect(numberValue("")).toBeUndefined();
    expect(numberValue("   ")).toBeUndefined();
  });

  it("rejects negatives and junk", () => {
    expect(numberValue("-5")).toBeUndefined();
    expect(numberValue("seven")).toBeUndefined();
  });

  it("keeps a genuine zero", () => {
    expect(numberValue("0")).toBe(0);
  });
});

describe("capacitySummary", () => {
  it("multiplies rooms by beds per room across every row", () => {
    expect(
      capacitySummary([
        { ...emptyRoomRow("a"), bedsPerRoom: "2", rooms: "10", vacantBeds: "3" },
        { ...emptyRoomRow("b"), bedsPerRoom: "4", rooms: "5", vacantBeds: "1" },
      ]),
    ).toEqual({ totalBeds: 40, totalRooms: 15, vacantBeds: 4 });
  });

  it("treats half-typed rows as zero rather than NaN", () => {
    expect(capacitySummary([emptyRoomRow("a")])).toEqual({
      totalBeds: 0,
      totalRooms: 0,
      vacantBeds: 0,
    });
  });
});

describe("buildHostelPayload", () => {
  it("derives the rent range from the rooms rather than asking for it twice", () => {
    const payload = buildHostelPayload(
      form({
        rooms: [
          { ...emptyRoomRow("a"), bedsPerRoom: "1", monthlyRent: "9000", rooms: "4" },
          { ...emptyRoomRow("b"), bedsPerRoom: "2", monthlyRent: "6500", rooms: "8" },
        ],
      }),
    );

    expect(payload.pricing.monthlyRentMin).toBe(6500);
    expect(payload.pricing.monthlyRentMax).toBe(9000);
  });

  it("leaves the range unset when no room states a rent", () => {
    const payload = buildHostelPayload(
      form({ rooms: [{ ...emptyRoomRow("a"), bedsPerRoom: "2", rooms: "4" }] }),
    );

    expect(payload.pricing.monthlyRentMin).toBeUndefined();
    expect(payload.pricing.monthlyRentMax).toBeUndefined();
  });

  it("labels the ID document with the type the owner chose", () => {
    const payload = buildHostelPayload(form({ idProofType: "Passport" }));

    expect(payload.documents).toContainEqual({
      claimToken: "claim-token-for-the-id-proof",
      documentType: "Passport",
      fileAssetId: "0123456789abcdef01234561",
    });
  });

  it("sends the rules document under the type the reviewer's queue expects", () => {
    expect(buildHostelPayload(form()).documents).toContainEqual({
      claimToken: "claim-token-for-the-house-rules",
      documentType: "Rules & policies",
      fileAssetId: "0123456789abcdef01234562",
    });
  });

  it("never sends a document by URL — only a private upload with its claim token", () => {
    const payload = buildHostelPayload(
      form({ idProof: { fileName: "citizenship.jpg", url: "https://cdn.example/id.jpg" } }),
    );

    expect(payload.documents.map((document) => document.documentType)).toEqual([
      "Rules & policies",
    ]);
  });

  /**
   * `textArraySchema` is `z.string().trim().min(1).max(80)` in an array capped at
   * 40. A rule typed as a paragraph would otherwise 422 the whole application.
   */
  it("cuts rule lines to the 80 characters the schema accepts", () => {
    const long = "x".repeat(200);
    const payload = buildHostelPayload(form({ rules: long }));

    expect(payload.rules[0]).toHaveLength(80);
  });

  it("keeps at most 40 rules", () => {
    const many = Array.from({ length: 60 }, (_, index) => `Rule ${index}`).join("\n");

    expect(buildHostelPayload(form({ rules: many })).rules).toHaveLength(40);
  });

  it("drops blank lines between rules", () => {
    expect(buildHostelPayload(form({ rules: "No smoking\n\n\nQuiet after 10" })).rules)
      .toEqual(["No smoking", "Quiet after 10"]);
  });

  it("carries the answers the schema has no field for in `notes`", () => {
    const payload = buildHostelPayload(
      form({ landmark: "Opposite the campus gate", totalFloors: "3" }),
    );

    expect(payload.notes).toContain("Landmark: Opposite the campus gate");
    expect(payload.notes).toContain("Floors: 3");
    // The app stopped asking for a plan, so a plan line would claim a choice never made.
    expect(payload.notes).not.toContain("Pro Plan");
  });

  it("sends the owner's pin as MANUAL, with the landmark and the Maps link as fields", () => {
    const payload = buildHostelPayload(
      form({
        landmark: "Opposite the campus gate",
        mapLink: " https://maps.app.goo.gl/abc123 ",
      }),
    );

    expect(payload.location).toMatchObject({
      lat: 27.7033,
      lng: 85.3262,
      locationSource: "MANUAL",
    });
    expect(payload.landmark).toBe("Opposite the campus gate");
    expect(payload.mapLink).toBe("https://maps.app.goo.gl/abc123");
  });

  it("sends no coordinates at all when nothing was pinned", () => {
    const payload = buildHostelPayload(form({ mapLink: "", pin: null }));

    expect(payload.location).not.toHaveProperty("lat");
    expect(payload.location).not.toHaveProperty("locationSource");
    expect(payload.mapLink).toBeUndefined();
  });

  it("uses the same email for the applicant and the hostel contact", () => {
    const payload = buildHostelPayload(form());

    expect(payload.applicant.email).toBe("owner@example.com");
    expect(payload.contact.email).toBe("owner@example.com");
  });

  it("ignores a room row with no type, and never emits a NaN count", () => {
    const payload = buildHostelPayload(
      form({
        rooms: [
          { ...emptyRoomRow("a"), bedsPerRoom: "2", rooms: "4" },
          { ...emptyRoomRow("b", ""), bedsPerRoom: "", rooms: "" },
        ],
      }),
    );

    expect(payload.roomConfigurations).toHaveLength(1);
    expect(payload.roomConfigurations[0].bedsPerRoom).toBe(2);
    expect(payload.roomTypes).toEqual(["Single Room"]);
  });
});

describe("RULES_TEMPLATES", () => {
  it("carries the website's three, so both clients attach the same document", () => {
    expect(RULES_TEMPLATES.map((template) => template.id)).toEqual([
      "standard",
      "student-strict",
      "flexible",
    ]);
  });

  it("has a body worth uploading in each", () => {
    for (const template of RULES_TEMPLATES) {
      expect(template.body.length).toBeGreaterThan(200);
    }
  });
});

describe("isHostelStepComplete", () => {
  it("agrees with the errors it is derived from", () => {
    expect(isHostelStepComplete("basics", form())).toBe(true);
    expect(isHostelStepComplete("basics", form({ hostelName: "" }))).toBe(false);
  });
});


it("keeps a separately stated form fee in the registration payload", () => {
  const draft = form({ formFee: "300" });
  expect(buildHostelPayload(draft).pricing?.formFee).toBe(300);
  expect(hostelStepErrors("rooms", form({ formFee: "-1" })).formFee).toBeTruthy();
});
