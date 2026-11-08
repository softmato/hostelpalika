import { describe, expect, it } from "vitest";

import { demoHostels, demoHostelsMatching, findDemoHostel } from "./demo-hostels";

describe("demo hostels", () => {
  it("are emptied out of the site", () => {
    expect(demoHostels).toHaveLength(0);
    expect(demoHostelsMatching({})).toHaveLength(0);
    expect(findDemoHostel("saathi-ghar-boys-hostel-new-baneshwor")).toBeUndefined();
  });
});
