import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The live phone check the ID form runs, and the rule the save re-applies: a
 * card's main phone is TAKEN when another account signs in with it or another
 * card lists it — matched across the ways one number is typed.
 */
const mocks = vi.hoisted(() => ({
  cardExists: vi.fn(),
  userFind: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ connectToDatabase: vi.fn() }));

vi.mock("@/lib/personal-data-crypto", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  personalLookupHash: (value: string) => `hash:${value}`,
}));

vi.mock("@hostel/db/models/User", () => ({
  UserModel: { find: mocks.userFind },
}));

vi.mock("@hostel/db/models/UserResidentProfile", () => ({
  UserResidentProfileModel: { exists: mocks.cardExists },
}));

import { checkResidentPhone } from "@/modules/users/resident-identity.service";

const me = "64f0f0f0f0f0f0f0f0f0f0a1";
const someoneElse = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0b2");

function accountsWithPhone(ids: Types.ObjectId[]) {
  mocks.userFind.mockReturnValue({
    select: () => ({ limit: () => ({ lean: async () => ids.map((_id) => ({ _id })) }) }),
  });
}

describe("checkResidentPhone", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cardExists.mockResolvedValue(null);
    accountsWithPhone([]);
  });

  it("is TAKEN when another account signs in with the number, however it was typed", async () => {
    accountsWithPhone([someoneElse]);

    await expect(checkResidentPhone(me, "+977 981-234-5678")).resolves.toMatchObject({
      status: "TAKEN",
    });
    // The bare and +977 spellings are both asked for.
    expect(mocks.userFind.mock.calls[0]![0].phone.$in).toEqual(
      expect.arrayContaining(["9812345678", "+9779812345678"]),
    );
  });

  it("is TAKEN when another card lists it, by its blind index", async () => {
    mocks.cardExists.mockResolvedValue({ _id: "card" });

    await expect(checkResidentPhone(me, "9812345678")).resolves.toMatchObject({
      status: "TAKEN",
    });
    expect(mocks.cardExists).toHaveBeenCalledWith(
      expect.objectContaining({ primaryPhoneHash: "hash:phone:9812345678" }),
    );
  });

  it("is YOURS for this account's own phone and AVAILABLE for a new one", async () => {
    accountsWithPhone([new Types.ObjectId(me)]);
    await expect(checkResidentPhone(me, "9812345678")).resolves.toMatchObject({
      status: "YOURS",
    });

    accountsWithPhone([]);
    await expect(checkResidentPhone(me, "9812345678")).resolves.toMatchObject({
      status: "AVAILABLE",
    });
  });
});
