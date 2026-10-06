import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EvidenceReadFailure } from "@/modules/finance/evidence-engine";

/**
 * Vision falling through to Gemini, and — more importantly — the cases where it
 * must not.
 *
 * The fallback exists because this pipeline has twice lost every receipt read on
 * the platform to a single remote dependency going quiet, with no symptom except
 * residents being told their screenshots were unreadable. It is deliberately
 * narrow: a second engine that runs too eagerly is how a "temporary" fallback
 * becomes the engine that has been serving production for six months while the
 * bill for the first one is still being paid.
 */

const mocks = vi.hoisted(() => ({
  gemini: vi.fn(),
  vision: vi.fn(),
}));

vi.mock("@/modules/finance/evidence-vision", () => ({
  isVisionConfigured: () => true,
  readWithVision: mocks.vision,
}));

vi.mock("@/modules/finance/evidence-gemini", () => ({
  isGeminiConfigured: () => true,
  readWithGemini: mocks.gemini,
}));

/*
 * Preparation is stubbed to a plain buffer.
 *
 * The dispatch under test is about which engine is asked and when; decoding is
 * `sharp`'s business and has its own coverage. Stubbing it also keeps this suite
 * from depending on a native module being installed to prove a branch.
 */
const header = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock("@/lib/sharp", () => ({
  loadSharp: async () => () => ({
    metadata: async () => header.value,
    png: () => ({ toBuffer: async () => Buffer.from("prepared") }),
    resize: function () {
      return this;
    },
    rotate: function () {
      return this;
    },
  }),
}));

import { readEvidence } from "@/modules/finance/evidence-ocr";

const IMAGE = Buffer.from("not-really-an-image");

function succeeded(engine: "gemini" | "vision", text: string) {
  return { failure: null, result: { engine, ms: 5, text, words: [] } };
}

function failed(failure: EvidenceReadFailure) {
  return { failure, result: null };
}

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ["EVIDENCE_ENGINE", "EVIDENCE_OCR"]) {
    saved[key] = process.env[key];
    delete process.env[key];
  }

  process.env.EVIDENCE_ENGINE = "vision+gemini";
  mocks.gemini.mockReset();
  mocks.vision.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const key of ["EVIDENCE_ENGINE", "EVIDENCE_OCR"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }

  vi.restoreAllMocks();
});

describe("vision+gemini — the steady state costs one read", () => {
  it("never asks Gemini when Vision answered", async () => {
    mocks.vision.mockResolvedValue(succeeded("vision", "Txn 1QAXP2M"));

    const read = await readEvidence(IMAGE, "image/png");

    expect(read.result?.engine).toBe("vision");
    expect(read.result?.text).toBe("Txn 1QAXP2M");
    expect(mocks.gemini).not.toHaveBeenCalled();
  });

  /*
   * The one failure that is really an answer. Vision ran, it looked, and the
   * page carries no text — a fact about the file, not about Vision. Handing a
   * page already known to be blank to a language model and asking what it says
   * is an invitation to be told something is there.
   */
  it("never asks Gemini about a page Vision read as blank", async () => {
    mocks.vision.mockResolvedValue(failed("empty"));

    const read = await readEvidence(IMAGE, "image/png");

    expect(read.failure).toBe("empty");
    expect(mocks.gemini).not.toHaveBeenCalled();
  });
});

describe("vision+gemini — when Vision does not answer", () => {
  it.each<EvidenceReadFailure>([
    "not-configured",
    "over-budget",
    "provider-error",
    "timeout",
    "unknown",
  ])("falls through on %s", async (failure) => {
    mocks.vision.mockResolvedValue(failed(failure));
    mocks.gemini.mockResolvedValue(succeeded("gemini", "Txn 1NVX5KB"));

    const read = await readEvidence(IMAGE, "image/png");

    expect(mocks.gemini).toHaveBeenCalledTimes(1);
    expect(read.failure).toBeNull();
    expect(read.result?.engine).toBe("gemini");
    expect(read.result?.text).toBe("Txn 1NVX5KB");
  });

  /*
   * `prepareForVision` re-encodes to PNG and Gemini is told what it is being
   * given rather than sniffing it. A fallback that forwarded the original mime
   * type would describe a PNG as a JPEG on every fall-through.
   */
  it("sends an upright screenshot under the cap as it is, typed as itself", async () => {
    header.value = { format: "jpeg", height: 2340, orientation: 1, width: 1080 };
    mocks.vision.mockResolvedValue(failed("provider-error"));
    mocks.gemini.mockResolvedValue(succeeded("gemini", "text"));
    try {
      await readEvidence(IMAGE, "image/jpeg");
    } finally {
      header.value = {};
    }
    expect(mocks.vision).toHaveBeenCalledWith(IMAGE);
    expect(mocks.gemini).toHaveBeenCalledWith(IMAGE, "image/jpeg");
  });

  it("hands Gemini the same prepared PNG Vision was given", async () => {
    mocks.vision.mockResolvedValue(failed("provider-error"));
    mocks.gemini.mockResolvedValue(succeeded("gemini", "text"));

    await readEvidence(IMAGE, "image/jpeg");

    expect(mocks.gemini).toHaveBeenCalledWith(
      Buffer.from("prepared"),
      "image/png",
    );
    expect(mocks.vision).toHaveBeenCalledWith(Buffer.from("prepared"));
  });

  it("reports Gemini's reason when both engines come back empty-handed", async () => {
    mocks.vision.mockResolvedValue(failed("provider-error"));
    mocks.gemini.mockResolvedValue(failed("over-budget"));

    const read = await readEvidence(IMAGE, "image/png");

    expect(read.result).toBeNull();
    expect(read.failure).toBe("over-budget");
  });

  /*
   * A silent fallback is a fallback nobody notices is load-bearing, and the bill
   * for the engine that stopped answering goes on being paid. The log line is
   * how somebody finds out Vision has been down since Tuesday while receipts
   * kept reading fine.
   */
  it("says so in the log, loudly, on both sides", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    mocks.vision.mockResolvedValue(failed("provider-error"));
    mocks.gemini.mockResolvedValue(failed("timeout"));

    await readEvidence(IMAGE, "image/png");

    const lines = logged.mock.calls.map(([line]) => String(line)).join("\n");

    expect(lines).toContain("[evidence-fallback]");
    expect(lines).toContain("provider-error");
    expect(lines).toContain("timeout");
  });
});

describe("the single-engine modes stay single", () => {
  /*
   * The scoring harness sets EVIDENCE_ENGINE to the engine it is measuring. A
   * `vision` that quietly answered with Gemini would report Gemini's score as
   * Vision's, and this pipeline's entire history is measurements that were not
   * measuring what they claimed.
   */
  it("vision alone does not reach for Gemini, even on a failure", async () => {
    process.env.EVIDENCE_ENGINE = "vision";
    mocks.vision.mockResolvedValue(failed("provider-error"));

    const read = await readEvidence(IMAGE, "image/png");

    expect(read.failure).toBe("provider-error");
    expect(mocks.gemini).not.toHaveBeenCalled();
  });

  it("gemini alone never calls Vision", async () => {
    process.env.EVIDENCE_ENGINE = "gemini";
    mocks.gemini.mockResolvedValue(succeeded("gemini", "text"));

    const read = await readEvidence(IMAGE, "image/png");

    expect(read.result?.engine).toBe("gemini");
    expect(mocks.vision).not.toHaveBeenCalled();
  });

  it("stays switched off when EVIDENCE_OCR is off", async () => {
    process.env.EVIDENCE_OCR = "off";

    const read = await readEvidence(IMAGE, "image/png");

    expect(read.failure).toBe("disabled");
    expect(mocks.vision).not.toHaveBeenCalled();
    expect(mocks.gemini).not.toHaveBeenCalled();
  });
});
