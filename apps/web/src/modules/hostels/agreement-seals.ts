import { GetObjectCommand } from "@aws-sdk/client-s3";

import { getR2Client, privateBucket, withKeyPrefix } from "@/lib/r2";

/**
 * The company's side of a signed agreement: both founders' signatures and the
 * company stamp, printed on the PDF when the agreement is issued.
 *
 * **These live in the private R2 bucket, never in git.** The repository is
 * public, and a transparent PNG of a director's signature beside the company
 * stamp is a forgery kit. They are put there once by
 * `scripts/upload-agreement-seals.mts` and read only here, server-side.
 *
 * Read once per server instance and kept: the three files never change between
 * deploys, so after the first agreement an instance renders with no storage
 * round trip. A missing file is skipped — the agreement still goes out, with
 * the company's printed name instead of a signature — because an approval
 * email held back over an image is worse than one without it.
 */

export const AGREEMENT_SEAL_KEY = "platform/agreement-seals";

export const AGREEMENT_SIGNERS = [
  { file: "signature-jiwan.png", name: "Jiwan Mijhar", title: "Founder" },
  { file: "signature-siddhant.png", name: "Siddhant Yadav", title: "Founder" },
] as const;

export const AGREEMENT_STAMP_FILE = "stamp.png";

export type AgreementSeals = {
  signatures: { image: Uint8Array | null; name: string; title: string }[];
  stamp: Uint8Array | null;
};

async function read(file: string) {
  try {
    const object = await getR2Client().send(
      new GetObjectCommand({ Bucket: privateBucket(), Key: withKeyPrefix(`${AGREEMENT_SEAL_KEY}/${file}`) }),
    );

    return (await object.Body?.transformToByteArray()) ?? null;
  } catch (error) {
    console.error(
      JSON.stringify({
        action: "agreement_seal_missing",
        file,
        level: "error",
        message: error instanceof Error ? error.message : String(error),
      }),
    );

    return null;
  }
}

let cached: Promise<AgreementSeals> | null = null;

export function loadAgreementSeals(): Promise<AgreementSeals> {
  cached ??= Promise.all([read(AGREEMENT_STAMP_FILE), ...AGREEMENT_SIGNERS.map((signer) => read(signer.file))]).then(
    ([stamp, ...images]) => {
      // A failed read is not cached: the next render tries again.
      if (!stamp || images.some((image) => !image)) cached = null;

      return {
        signatures: AGREEMENT_SIGNERS.map((signer, index) => ({ image: images[index] ?? null, name: signer.name, title: signer.title })),
        stamp,
      };
    },
  );

  return cached;
}
