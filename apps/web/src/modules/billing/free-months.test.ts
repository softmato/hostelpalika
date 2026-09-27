import { describe, expect, it } from "vitest";

import { bsMonthsEnd } from "@hostel/shared/calendar/bs";

import { freeMonthOf, isSameBuilding, panKey, phoneKey, type BuildingPrint } from "./free-months";

const claim: BuildingPrint = {
  area: "baneshwor",
  lat: 27.6915,
  lng: 85.342,
  nameKey: "study sanjal",
  ownerPhone: "9800000000",
  panNumber: "601234567",
};

const stranger: BuildingPrint = {
  area: "lazimpat",
  lat: 27.72,
  lng: 85.32,
  nameKey: "everest",
  ownerPhone: "9811111111",
  panNumber: "609999999",
};

describe("isSameBuilding", () => {
  it("matches a re-registration under a new email by name and area", () => {
    expect(isSameBuilding(claim, { ...stranger, area: "baneshwor", nameKey: "study sanjal" })).toBe(true);
  });

  it("matches the same PAN anywhere", () => {
    expect(isSameBuilding(claim, { ...stranger, panNumber: "601234567" })).toBe(true);
  });

  it("matches a pin within 50 m, not one 200 m away", () => {
    expect(isSameBuilding(claim, { ...stranger, lat: 27.6918, lng: 85.342 })).toBe(true);
    expect(isSameBuilding(claim, { ...stranger, lat: 27.6933, lng: 85.342 })).toBe(false);
  });

  it("matches the owner phone only inside one area", () => {
    expect(isSameBuilding(claim, { ...stranger, area: "baneshwor", ownerPhone: "9800000000" })).toBe(true);
    expect(isSameBuilding(claim, { ...stranger, ownerPhone: "9800000000" })).toBe(false);
  });

  it("leaves a different building alone", () => {
    expect(isSameBuilding(claim, stranger)).toBe(false);
  });
});

describe("keys", () => {
  it("normalises phones and PANs", () => {
    expect(phoneKey("+977 980-0000000")).toBe("9800000000");
    expect(phoneKey("12")).toBeNull();
    expect(panKey("601 234 567")).toBe("601234567");
    expect(panKey("60123")).toBeNull();
  });
});

describe("freeMonthOf", () => {
  const activatedAt = new Date("2026-09-11T06:00:00Z");
  const freeUntil = bsMonthsEnd(activatedAt, 6);

  it("counts the month in and the ones still to come", () => {
    expect(freeMonthOf({ activatedAt, freeMonths: 6, freeUntil }, activatedAt)).toMatchObject({
      left: 5,
      month: 1,
      of: 6,
    });
    const second = new Date(bsMonthsEnd(activatedAt, 1).getTime() + 1);
    expect(freeMonthOf({ activatedAt, freeMonths: 6, freeUntil }, second)).toMatchObject({ left: 4, month: 2 });
    expect(freeMonthOf({ activatedAt, freeMonths: 6, freeUntil }, freeUntil)).toMatchObject({ left: 0, month: 6 });
  });

  it("is over after the last free day, and absent without free months", () => {
    expect(freeMonthOf({ activatedAt, freeMonths: 6, freeUntil }, new Date(freeUntil.getTime() + 1))).toBeNull();
    expect(freeMonthOf({ activatedAt, freeMonths: 0, freeUntil: null }, activatedAt)).toBeNull();
  });
});
