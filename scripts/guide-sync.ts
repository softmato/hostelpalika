/**
 * The private user guide ↔ the private R2 bucket.
 *
 *   npx tsx --env-file=.env scripts/guide-sync.ts check   # Nepali in step, every picture present
 *   npx tsx --env-file=.env scripts/guide-sync.ts push    # check, then upload content + pictures
 *   npx tsx --env-file=.env scripts/guide-sync.ts pull    # download them into guide-content/
 *
 * `guide-content/` (gitignored) holds `content.json` and `pictures/*.webp`. The
 * repository is public, so this folder is the only copy outside R2: pull before
 * editing on a new machine. Readers see a push within five minutes (server cache).
 * Bump the version in Platform → Website Config → Legal Pages after a real change.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { guidePages, guidePagesFor, guidePictureName, guideProblems, type GuideContent } from "../packages/shared/src/guide/guide";

const ROOT = join(__dirname, "..");
const DIR = join(ROOT, "guide-content");
const PICTURES = join(DIR, "pictures");
const CONTENT = join(DIR, "content.json");

function env(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (run with --env-file=.env)`);
  return value;
}

/** Same rule as `withKeyPrefix` in apps/web/src/lib/r2.ts and the Go storage package. */
function key(path: string) {
  const prefix = (process.env.R2_KEY_PREFIX ?? "").replace(/^\/+|\/+$/g, "");
  return prefix ? `${prefix}/${path}` : path;
}

function client() {
  return new S3Client({
    credentials: { accessKeyId: env("R2_ACCESS_KEY_ID"), secretAccessKey: env("R2_SECRET_ACCESS_KEY") },
    endpoint: env("R2_ENDPOINT"),
    region: "auto",
  });
}

function pictureNames(content: GuideContent, pages = guidePages(content)) {
  return [...new Set(pages.flatMap((p) => [p.chapter.flow, p.chapter.shot]).flatMap((pic) => (pic ? [guidePictureName(pic.src)] : [])))];
}

function check(): { content: GuideContent; raw: string } {
  const raw = readFileSync(CONTENT, "utf8");
  const content = JSON.parse(raw) as GuideContent;
  const problems = guideProblems(content);
  for (const name of pictureNames(content)) {
    if (!existsSync(join(PICTURES, name))) problems.push(`picture ${name}: missing from guide-content/pictures`);
  }
  // Public chapters' pictures are also served from the site, for link previews.
  for (const name of pictureNames(content, guidePagesFor(content, "visitor"))) {
    if (!existsSync(join(ROOT, "apps/web/public/guide", name))) problems.push(`picture ${name}: public chapter, missing from apps/web/public/guide`);
  }
  if (problems.length) {
    console.error(problems.map((p) => `✗ ${p}`).join("\n"));
    process.exit(1);
  }
  console.log(`✓ ${guidePages(content).length} chapters, ${pictureNames(content).length} pictures`);
  return { content, raw };
}

async function push() {
  const { content, raw } = check();
  const s3 = client();
  const bucket = env("R2_BUCKET_PRIVATE");
  for (const name of pictureNames(content)) {
    await s3.send(new PutObjectCommand({ Body: readFileSync(join(PICTURES, name)), Bucket: bucket, ContentType: "image/webp", Key: key(`guide/pictures/${name}`) }));
    console.log(`↑ ${name}`);
  }
  // Content last, so no reader is ever pointed at a picture that is not there yet.
  await s3.send(new PutObjectCommand({ Body: raw, Bucket: bucket, ContentType: "application/json", Key: key("guide/content.json") }));
  console.log("↑ content.json — live within five minutes");
}

async function pull() {
  const s3 = client();
  const bucket = env("R2_BUCKET_PRIVATE");
  const get = async (path: string) =>
    Buffer.from(await (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key(path) }))).Body!.transformToByteArray());
  mkdirSync(PICTURES, { recursive: true });
  const raw = (await get("guide/content.json")).toString("utf8");
  writeFileSync(CONTENT, raw);
  for (const name of pictureNames(JSON.parse(raw) as GuideContent)) {
    writeFileSync(join(PICTURES, name), await get(`guide/pictures/${name}`));
    console.log(`↓ ${name}`);
  }
  console.log("↓ content.json");
}

const commands: Record<string, () => unknown> = { check, pull, push };
const run = commands[process.argv[2] ?? ""];
if (!run) {
  console.error("usage: guide-sync.ts check | push | pull");
  process.exit(2);
}
void Promise.resolve(run()).catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
