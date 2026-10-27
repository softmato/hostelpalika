import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";

import {
  ArchiveError,
  keyFromRecoveryCode,
  openArchive,
  readArchiveHeader,
  recoveryCodeFromKey,
  sealArchive,
  utf8Decode,
  utf8Encode,
} from "@hostel/shared/backup/sealed-archive";

const owner = nacl.box.keyPair();
const meta = { createdAt: "2026-10-27T20:15:00.000Z", hostelId: "6a0000000000000000000001" };
const text = '{"name":"नेपाल secret-marker 🏠"}';

const failsWith = (code: ArchiveError["code"], run: () => unknown) => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ArchiveError);
    expect((error as ArchiveError).code).toBe(code);
    return;
  }
  throw new Error("expected a failure");
};

describe("sealed archive", () => {
  it("round-trips with the owner's key", () => {
    const file = sealArchive(nacl, utf8Encode(text), owner.publicKey, meta);
    const { header, plaintext } = openArchive(nacl, file, owner.secretKey);

    expect(utf8Decode(plaintext)).toBe(text);
    expect(header).toMatchObject(meta);
  });

  it("holds no plaintext and differs every time", () => {
    const a = sealArchive(nacl, utf8Encode(text), owner.publicKey, meta);
    const b = sealArchive(nacl, utf8Encode(text), owner.publicKey, meta);

    expect(Buffer.from(a).toString("latin1")).not.toContain("secret-marker");
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it("refuses another key", () => {
    const file = sealArchive(nacl, utf8Encode(text), owner.publicKey, meta);

    failsWith("WRONG_KEY", () => openArchive(nacl, file, nacl.box.keyPair().secretKey));
  });

  it("refuses a flipped byte in the data", () => {
    const file = sealArchive(nacl, utf8Encode(text), owner.publicKey, meta);

    file[file.length - 3] ^= 1;
    failsWith("DAMAGED", () => openArchive(nacl, file, owner.secretKey));
  });

  it("refuses a header edited to claim another hostel", () => {
    const file = sealArchive(nacl, utf8Encode(text), owner.publicKey, meta);
    const edited = Buffer.from(Buffer.from(file).toString("latin1").replace(meta.hostelId, "6b0000000000000000000002"), "latin1");

    expect(readArchiveHeader(edited).header.hostelId).toBe("6b0000000000000000000002");
    failsWith("DAMAGED", () => openArchive(nacl, edited, owner.secretKey));
  });

  it("refuses something that is not an archive", () => {
    failsWith("NOT_AN_ARCHIVE", () => openArchive(nacl, utf8Encode("hello world"), owner.secretKey));
  });
});

describe("recovery code", () => {
  it("brings the same key back, spaces and case aside", () => {
    const code = recoveryCodeFromKey(nacl, owner.secretKey);

    expect(code.split(" ")).toHaveLength(14);
    expect(keyFromRecoveryCode(nacl, code.toLowerCase().replace(/ /g, "  "))).toEqual(owner.secretKey);
  });

  it("catches a mistyped character", () => {
    const code = recoveryCodeFromKey(nacl, owner.secretKey);
    const wrong = (code[0] === "A" ? "B" : "A") + code.slice(1);

    expect(keyFromRecoveryCode(nacl, wrong)).toBeNull();
  });
});
