import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import {
  guideForReader,
  guidePictureName,
  lockedGroups,
  parseGuideContent,
  withPictureUrls,
  type GuideContent,
  type GuideReader,
} from "@hostel/shared/guide/guide";

import { getR2Client, privateBucket, readFromR2, withKeyPrefix } from "@/lib/r2";
import { getSiteConfigSection } from "@/modules/platform-config/site-config.service";

/**
 * The private user guide (see `packages/shared/src/guide/guide.ts`): one JSON and
 * its pictures in the private R2 bucket, uploaded by `scripts/guide-sync.ts`.
 */
export const GUIDE_CONTENT_KEY = "guide/content.json";
export const guidePictureKey = (name: string) => `guide/pictures/${name}`;

/** Long enough to read the whole guide in one sitting; pictures load as the reader scrolls. */
export const GUIDE_PICTURE_TTL_SECONDS = 6 * 60 * 60;

/** A pushed edit reaches readers within this long. */
const CACHE_MS = 5 * 60 * 1000;

let cached: { at: number; content: GuideContent } | null = null;

/** The whole stored guide, or null when R2 cannot give it (then the last good copy, if any). */
export async function loadGuideContent(): Promise<GuideContent | null> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.content;
  try {
    const chunks: Uint8Array[] = [];
    for await (const chunk of await readFromR2(privateBucket(), withKeyPrefix(GUIDE_CONTENT_KEY))) chunks.push(chunk);
    cached = { at: Date.now(), content: parseGuideContent(Buffer.concat(chunks).toString("utf8")) };
    return cached.content;
  } catch (error) {
    console.error("[guide] content could not be read from R2", error);
    return cached?.content ?? null;
  }
}

/**
 * `GET /api/v1/guide`: what one reader may read, each picture signed, the parts
 * they may not open by name only, and the version line. Null when the content
 * cannot be loaded.
 */
export async function guideFor(reader: GuideReader) {
  const content = await loadGuideContent();
  if (!content) return null;

  const mine = guideForReader(content, reader);
  const names = [
    ...new Set(mine.groups.flatMap((g) => g.chapters.flatMap((c) => [c.flow, c.shot])).flatMap((p) => (p ? [guidePictureName(p.src)] : []))),
  ];
  const signed = new Map(
    await Promise.all(
      names.map(async (name) => {
        const command = new GetObjectCommand({ Bucket: privateBucket(), Key: withKeyPrefix(guidePictureKey(name)) });
        return [name, await getSignedUrl(getR2Client(), command, { expiresIn: GUIDE_PICTURE_TTL_SECONDS })] as const;
      }),
    ),
  );
  const { guide } = await getSiteConfigSection("legal");

  return {
    guide: withPictureUrls(mine, (src) => signed.get(guidePictureName(src)) ?? src),
    locked: lockedGroups(content, reader),
    reader,
    updatedAt: guide.updatedAt,
    version: guide.version,
  };
}
