import { describe, expect, it } from "vitest";

import {
  applicantProblem,
  detailsContacts,
  detailsFromDraft,
  detailsSections,
  documentsProblem,
  emptyApplicantDraft,
} from "@/lib/resident-details";

function draft(patch: Partial<ReturnType<typeof emptyApplicantDraft>> = {}) {
  return { ...emptyApplicantDraft(), firstName: "Ram", lastName: "Thapa", phone: "9812345678", ...patch };
}

describe("application form", () => {
  it("needs a name and a number, nothing else", () => {
    expect(applicantProblem(draft())).toBeNull();
    expect(applicantProblem(draft({ lastName: " " }))).toMatch(/name/);
    expect(applicantProblem(draft({ phone: "12" }))).toMatch(/number/);
    expect(applicantProblem(draft({ dateOfBirth: "12/3/2004" }))).toMatch(/YYYY-MM-DD/);
  });

  it("leaves blank boxes out and keeps only the family who were named", () => {
    const details = detailsFromDraft(
      draft({ district: " Kathmandu ", fatherName: "Hari Thapa", fatherPhone: "9800000001", motherName: "" }),
    );

    expect(details.district).toBe("Kathmandu");
    expect(details.tole).toBeUndefined();
    expect(details.family).toEqual([
      { name: "Hari Thapa", occupation: undefined, phone: "9800000001", relation: "Father" },
    ]);
    expect(details.localGuardian).toBeUndefined();
  });

  it("turns family with phones into guardian records and the local guardian into the emergency contact", () => {
    const details = detailsFromDraft(
      draft({
        fatherName: "Hari Thapa",
        fatherPhone: "9800000001",
        localName: "Sita KC",
        localPhone: "9800000003",
        motherName: "Gita Thapa",
      }),
    );
    const contacts = detailsContacts(details);

    expect(contacts.guardians).toEqual([
      { firstName: "Hari", isPrimary: true, lastName: "Thapa", phone: "9800000001", relation: "Father" },
    ]);
    expect(contacts.emergencyContact).toEqual({
      isPrimary: true,
      name: "Sita KC",
      phone: "9800000003",
      relation: "Local guardian",
    });
  });

  it("reads back only the sections that have something in them", () => {
    const sections = detailsSections(detailsFromDraft(draft({ food: "EGGETARIAN", wardNo: "32" })));

    expect(sections.map((section) => section.title)).toEqual(["Personal", "Address"]);
    expect(sections[0]!.facts).toEqual([{ label: "Food", value: "Only egg" }]);
    expect(detailsSections(null)).toEqual([]);
  });
});

describe("documents on the form", () => {
  const up = { claimToken: "t".repeat(20), fileAssetId: "a".repeat(24), uri: "file://x" };

  it("always wants their own ID, the guardian's only when the hostel says so", () => {
    expect(documentsProblem({}, false)).toMatch(/citizenship or ID/);
    expect(documentsProblem({ APPLICANT_ID: up }, false)).toBeNull();
    expect(documentsProblem({ APPLICANT_ID: up }, true)).toMatch(/guardian/);
    expect(documentsProblem({ APPLICANT_ID: up, GUARDIAN_ID: { uri: "file://y" } }, false)).toMatch(/uploading/);
  });
});
