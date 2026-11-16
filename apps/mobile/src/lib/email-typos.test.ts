import { describe, expect, it } from "vitest";

import { suggestEmail } from "@hostel/constants/email-typos";

describe("suggestEmail", () => {
  it("fixes common gmail typos", () => {
    for (const typo of ["gmial.com", "gamil.com", "gmail.con", "gmai.com", "gmail.co", "gnail.com", "gmailcom", "gmail"]) {
      expect(suggestEmail(`Ram.Thapa@${typo}`)).toBe("ram.thapa@gmail.com");
    }
  });

  it("fixes other providers", () => {
    expect(suggestEmail("a@yaho.com")).toBe("a@yahoo.com");
    expect(suggestEmail("a@hotmial.com")).toBe("a@hotmail.com");
    expect(suggestEmail("a@outlok.com")).toBe("a@outlook.com");
  });

  it("leaves correct and real addresses alone", () => {
    for (const ok of ["a@gmail.com", " A@Gmail.com ", "a@ymail.com", "a@mail.com", "a@live.com", "a@softmato.com", "a@tu.edu.np", "", "nope", "@gmail.com"]) {
      expect(suggestEmail(ok)).toBeNull();
    }
  });
});
