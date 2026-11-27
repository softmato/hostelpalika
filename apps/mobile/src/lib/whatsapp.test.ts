import { describe, expect, it } from "vitest";

import { whatsappUrl } from "./whatsapp";

describe("whatsappUrl", () => {
  it("adds Nepal's code to a local number and encodes the message", () => {
    expect(whatsappUrl("98-0000 0000")).toBe("https://wa.me/9779800000000");
    expect(whatsappUrl("+977 9800000000", "Hi & ID: HH-1")).toBe("https://wa.me/9779800000000?text=Hi%20%26%20ID%3A%20HH-1");
  });
});
