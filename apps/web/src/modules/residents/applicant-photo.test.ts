import { describe, expect, it } from "vitest";

import { missingDocument } from "@/modules/residents/applicant-photo";

describe("admission form documents", () => {
  it("always needs the applicant's own ID", () => {
    expect(missingDocument([], false)).toMatch(/your citizenship/);
    expect(missingDocument(["GUARDIAN_ID"], false)).toMatch(/your citizenship/);
  });

  it("asks for the guardian's ID only when the hostel requires it", () => {
    expect(missingDocument(["APPLICANT_ID"], false)).toBeNull();
    expect(missingDocument(["APPLICANT_ID"], true)).toMatch(/guardian/);
    expect(missingDocument(["APPLICANT_ID", "GUARDIAN_ID"], true)).toBeNull();
  });
});
