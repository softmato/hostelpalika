import { describe, expect, it } from "vitest";

import {
  buildHostelPayload,
  emptyHostelForm,
  emptyRoomRow,
  type HostelForm,
} from "../../../../mobile/src/lib/hostel-registration";
import {
  buildProviderPayload,
  EMPTY_PROVIDER_FORM,
  type ProviderForm,
} from "../../../../mobile/src/lib/provider-registration";
import { hostelRegistrationSchema } from "./hostel-registration.validation";
import { publicHostelApplicationCreateSchema } from "./hostel.validation";
import { serviceProviderRegisterSchema } from "../service-providers/service-provider.validation";

/**
 * The mobile registration wizards, checked against the schemas that will actually
 * parse them.
 *
 * ## Why this test lives in `apps/web`
 *
 * Because the schemas do. `apps/mobile` has its own `node_modules` and its own
 * Metro resolver and cannot import this workspace, so a mobile-side test could
 * only assert against a **hand-copied** description of the contract — which is
 * exactly the failure this repository keeps hitting: a client type that says what
 * someone believed the server wanted. Here the assertion is against
 * `publicHostelApplicationCreateSchema` and `serviceProviderRegisterSchema`
 * themselves, so a bound moving on the server breaks this file rather than a
 * hostel owner's submit button.
 *
 * The import reaches across workspaces in one direction only and touches two
 * files that have **no imports at all** — `hostel-registration.ts` and
 * `provider-registration.ts` are pure value modules for this reason. Nothing here
 * pulls React Native into the web test run.
 */

/* -------------------------------------------------------------------------- */
/* Hostel registration                                                        */
/* -------------------------------------------------------------------------- */

function hostelForm(overrides: Partial<HostelForm> = {}): HostelForm {
  return {
    ...emptyHostelForm("room-1"),
    address: "Ward 4, Bagdol Marg",
    area: "Bagdol",
    description: "Quiet, close to the campus.",
    email: "owner@example.com",
    facilities: ["WiFi", "Hot water"],
    hostelName: "Green View Hostel",
    idProof: {
      claimToken: "claim-token-for-the-id-proof",
      fileAssetId: "0123456789abcdef01234561",
      fileName: "citizenship.jpg",
      url: "https://cdn.example.com/id.jpg",
    },
    idProofType: "Citizenship",
    landmark: "Opposite the campus gate",
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
    rules: "No smoking\nQuiet after 10 PM",
    rulesDocument: {
      claimToken: "claim-token-for-the-house-rules",
      fileAssetId: "0123456789abcdef01234562",
      fileName: "House rules.txt",
      url: "https://cdn.example.com/rules.txt",
    },
    totalFloors: "3",
    ...overrides,
  };
}

describe("the mobile hostel application against publicHostelApplicationCreateSchema", () => {
  it("parses a fully filled application", () => {
    const result = publicHostelApplicationCreateSchema.safeParse(
      buildHostelPayload(hostelForm()),
    );

    expect(result.success).toBe(true);
  });

  it("keeps the PAN and the short-stay rates through the route's own schema", () => {
    const parsed = hostelRegistrationSchema.parse(
      buildHostelPayload(
        hostelForm({
          panNumber: "123 456 789",
          shortStays: { enabled: true, minNights: "2", rates: { "Double Sharing": "450" } },
        }),
      ),
    );

    expect(parsed.panNumber).toBe("123456789");
    expect(parsed.shortStays).toEqual({
      enabled: true,
      minNights: 2,
      rates: [{ dailyRate: 450, roomType: "Double Sharing" }],
    });
  });

  it("parses the minimum the wizard will let someone submit", () => {
    // Every optional left empty: no photos, no admission fee, no landmark, no
    // rent on the single room. This is the shape the schema is most likely to
    // reject, because every `undefined` the builder emits lands here at once.
    const result = publicHostelApplicationCreateSchema.safeParse(
      buildHostelPayload(
        hostelForm({
          admissionFee: "",
          facilities: [],
          landmark: "",
          rooms: [{ ...emptyRoomRow("room-1"), bedsPerRoom: "2", rooms: "4" }],
          rules: "",
          totalFloors: "",
        }),
      ),
    );

    expect(result.success).toBe(true);
  });

  it("survives a rule typed as a paragraph — the 80-character entry cap", () => {
    const result = publicHostelApplicationCreateSchema.safeParse(
      buildHostelPayload(hostelForm({ rules: "x".repeat(400) })),
    );

    expect(result.success).toBe(true);
  });

  it("survives forty-plus rules — the 40-entry array cap", () => {
    const many = Array.from({ length: 80 }, (_, index) => `Rule ${index}`).join("\n");

    expect(
      publicHostelApplicationCreateSchema.safeParse(
        buildHostelPayload(hostelForm({ rules: many })),
      ).success,
    ).toBe(true);
  });

  it("keeps `notes` inside the 1000-character bound with a long landmark", () => {
    const result = publicHostelApplicationCreateSchema.safeParse(
      buildHostelPayload(hostelForm({ landmark: "a".repeat(900) })),
    );

    // A landmark is a free-text field on the phone and it is folded into `notes`
    // with three other facts. If this ever fails, the fold needs a budget rather
    // than the field needing a shorter maximum.
    expect(result.success).toBe(true);
  });

  it("emits the documents in the shape the schema's document array declares", () => {
    const parsed = publicHostelApplicationCreateSchema.parse(
      buildHostelPayload(hostelForm()),
    );

    expect(parsed.documents).toHaveLength(2);
    expect(parsed.documents.map((document) => document.documentType)).toEqual([
      "Citizenship",
      "Rules & policies",
    ]);
  });

  /*
   * Against `hostelRegistrationSchema`, the one `POST /public/hostels/register`
   * actually parses — zod strips undeclared keys silently, so a pin that is not
   * declared there reaches the database as nothing and the listing has no map.
   */
  it("keeps the owner's pin, landmark and Maps link through the register route's schema", () => {
    const parsed = hostelRegistrationSchema.parse(
      buildHostelPayload(hostelForm({ mapLink: "https://maps.app.goo.gl/abc123" })),
    );

    expect(parsed.location).toMatchObject({
      lat: 27.7033,
      lng: 85.3262,
      locationSource: "MANUAL",
    });
    expect(parsed.landmark).toBe("Opposite the campus gate");
    expect(parsed.mapLink).toBe("https://maps.app.goo.gl/abc123");
  });

  it("keeps the derived rent range and the capacity the review screen showed", () => {
    const parsed = publicHostelApplicationCreateSchema.parse(
      buildHostelPayload(hostelForm()),
    );

    expect(parsed.pricing?.monthlyRentMin).toBe(7000);
    expect(parsed.capacitySummary).toEqual({
      totalBeds: 20,
      totalRooms: 10,
      vacantBeds: 3,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Service-provider registration                                              */
/* -------------------------------------------------------------------------- */

function providerForm(overrides: Partial<ProviderForm> = {}): ProviderForm {
  return {
    ...EMPTY_PROVIDER_FORM,
    area: "Baneshwor",
    categories: ["PLUMBER", "ELECTRICIAN"],
    fullName: "Ram Bahadur",
    phone: "9800000000",
    selfie: {
      claimToken: "claim-token-for-the-selfie-photo",
      fileAssetId: "0123456789abcdef01234563",
      fileName: "Your photo",
      url: "https://cdn.example.com/selfie.jpg",
    },
    ...overrides,
  };
}

describe("the mobile provider application against serviceProviderRegisterSchema", () => {
  it("parses a fully filled application", () => {
    const result = serviceProviderRegisterSchema.safeParse(
      buildProviderPayload(
        providerForm({
          availability: "Weekdays, emergency",
          description: "Two vans, same-day call-out across the ring road.",
          documents: [
            {
              claimToken: "claim-token-for-the-licence",
              fileAssetId: "0123456789abcdef01234564",
              fileName: "licence.jpg",
              url: "https://cdn.example.com/licence.jpg",
            },
          ],
          experience: "12 years",
        }),
        "ram@example.com",
      ),
    );

    expect(result.success).toBe(true);
  });

  it("parses the minimum: name, phone, one trade, an area and the selfie", () => {
    expect(
      serviceProviderRegisterSchema.safeParse(
        buildProviderPayload(providerForm({ categories: ["PLUMBER"] }), null),
      ).success,
    ).toBe(true);
  });

  it("accepts every trade at once — the array's upper bound is 11", () => {
    const result = serviceProviderRegisterSchema.safeParse(
      buildProviderPayload(
        providerForm({
          categories: [
            "PLUMBER",
            "ELECTRICIAN",
            "DOCTOR_CLINIC",
            "INTERNET_TECHNICIAN",
            "CLEANER",
            "CARPENTER",
            "PAINTER",
            "WATER_SUPPLIER",
            "APPLIANCE_REPAIR",
            "ROOM_REPAIR",
            "OTHER",
          ],
        }),
        null,
      ),
    );

    expect(result.success).toBe(true);
  });

  it("stays inside the 8-document cap when the applicant attaches the maximum", () => {
    const documents = Array.from({ length: 7 }, (_, index) => ({
      claimToken: `claim-token-for-document-${index}`,
      fileAssetId: `0123456789abcdef0123456${index}`,
      fileName: `doc-${index}.jpg`,
      url: `https://cdn.example.com/doc-${index}.jpg`,
    }));

    const parsed = serviceProviderRegisterSchema.parse(
      buildProviderPayload(providerForm({ documents }), null),
    );

    expect(parsed.documents).toHaveLength(8);
  });

  it("sends the trades in tap order, so the headline trade survives the round trip", () => {
    const parsed = serviceProviderRegisterSchema.parse(
      buildProviderPayload(
        providerForm({ categories: ["ELECTRICIAN", "PLUMBER"] }),
        null,
      ),
    );

    expect(parsed.categories?.[0]).toBe("ELECTRICIAN");
  });
});
