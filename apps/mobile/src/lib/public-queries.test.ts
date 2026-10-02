import { describe, expect, it, vi } from "vitest";

import { publicQuery } from "@/lib/public-queries";

/*
 * `public-api` reaches `lib/api`, which is axios on React Native — Flow source
 * this node-side runner cannot parse. No loader is called here: every test is
 * about the key a set of filters produces, not about fetching.
 */
vi.mock("@/lib/public-api", () => ({
  comparePublicHostels: vi.fn(),
  listPublicHostels: vi.fn(),
}));

vi.mock("@/lib/site-config-api", () => ({ getSiteConfig: vi.fn() }));
vi.mock("@/lib/join-api", () => ({ getMyJoinRequest: vi.fn() }));

describe("publicQuery.hostels", () => {
  it("gives the unfiltered catalogue a bare key, so four screens share it", () => {
    expect(publicQuery.hostels().key).toBe("public:hostels");
    expect(publicQuery.hostels({}).key).toBe("public:hostels");
  });

  it("drops empty values rather than keying on them", () => {
    expect(publicQuery.hostels({ city: "", q: undefined } as never).key).toBe(
      "public:hostels",
    );
  });

  it("is the same question whichever order the filters arrive in", () => {
    expect(publicQuery.hostels({ q: "lalitpur", type: "BOYS" }).key).toBe(
      publicQuery.hostels({ type: "BOYS", q: "lalitpur" }).key,
    );
  });

  it("separates two different filters", () => {
    expect(publicQuery.hostels({ type: "BOYS" }).key).not.toBe(
      publicQuery.hostels({ type: "GIRLS" }).key,
    );
  });
});

describe("publicQuery.compare", () => {
  it("ignores the order the reader ticked the hostels in", () => {
    expect(publicQuery.compare(["b", "a"]).key).toBe(publicQuery.compare(["a", "b"]).key);
  });
});
