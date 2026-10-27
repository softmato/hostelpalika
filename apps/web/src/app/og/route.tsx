import { readFile } from "node:fs/promises";
import path from "node:path";

import { ImageResponse } from "next/og";
import type { NextRequest } from "next/server";

import { PLATFORM_NAME, PLATFORM_VENDOR } from "@hostel/shared/brand/brand";

import { verifiedOgText } from "@/lib/seo";
import { siteUrl } from "@/lib/site";

/**
 * The social card: what a link to any page looks like when it is shared on
 * WhatsApp, Facebook, X or LinkedIn, and what search shows beside a result.
 *
 * Only text signed by `ogImagePath` is drawn — see the note there. Anything
 * else gets the plain brand card, so this cannot print a sentence nobody wrote.
 *
 * The logos are the originals from `public/brand` — the HP mark, the wordmark
 * and Softmato's — never a redrawing of them. The title is set in Inter from
 * `src/lib/fonts`, the faces the ID card already ships. Both folders reach this
 * function through `outputFileTracingIncludes`.
 */

export const runtime = "nodejs";

const BRAND = "#0a8a4b";
const INK = "#0b0f0c";
const MUTED = "#5b635e";
const LINE = "#dfe5e1";
const DEFAULT_TITLE = "Hostels in Nepal & hostel management system";

type Face = { data: ArrayBuffer; name: string; style: "normal"; weight: 600 | 800 };

let faces: Promise<Face[]> | null = null;
let logos: Promise<Record<"mark" | "softmato" | "wordmark", string | null>> | null = null;

/** `next dev`, `next build` and a Vercel function run in apps/web; vitest may run a level up. */
async function readAppFile(...segments: string[]) {
  // The ignore comments stop the tracer treating the whole repo as this route's
  // dependencies; the folders it really reads come from outputFileTracingIncludes.
  const roots = [
    /*turbopackIgnore: true*/ process.cwd(),
    path.join(/*turbopackIgnore: true*/ process.cwd(), "apps", "web"),
  ];

  for (const dir of roots) {
    try {
      return await readFile(path.join(/*turbopackIgnore: true*/ dir, ...segments));
    } catch {
      // Try the next root.
    }
  }

  return null;
}

async function readFont(file: string) {
  const buffer = await readAppFile("src", "lib", "fonts", file);

  return buffer
    ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    : null;
}

async function readLogo(file: string) {
  const buffer = await readAppFile("public", "brand", file);

  return buffer ? `data:image/png;base64,${buffer.toString("base64")}` : null;
}

function loadLogos() {
  logos ??= Promise.all([
    readLogo("hostelpalika-mark.png"),
    readLogo("hostelpalika-wordmark.png"),
    readLogo("softmato.png"),
  ]).then(([mark, wordmark, softmato]) => ({ mark, softmato, wordmark }));

  return logos;
}

function loadFaces() {
  faces ??= Promise.all([
    readFont("Inter-SemiBold.ttf"),
    readFont("Inter-ExtraBold.ttf"),
  ]).then(([semiBold, extraBold]) => {
    const loaded: Face[] = [];
    if (semiBold) loaded.push({ data: semiBold as ArrayBuffer, name: "Inter", style: "normal", weight: 600 });
    if (extraBold) loaded.push({ data: extraBold as ArrayBuffer, name: "Inter", style: "normal", weight: 800 });
    return loaded;
  });

  return faces;
}

function titleSize(title: string) {
  if (title.length <= 40) return 76;
  if (title.length <= 70) return 64;
  return 54;
}

export async function GET(request: NextRequest) {
  const signed = verifiedOgText(request.nextUrl.searchParams);
  const title = signed?.title ?? DEFAULT_TITLE;
  const eyebrow = signed?.eyebrow ?? "";
  const host = new URL(siteUrl()).host;
  const [fonts, logo] = await Promise.all([loadFaces(), loadLogos()]);

  return new ImageResponse(
    (
      <div
        style={{
          background: "#ffffff",
          display: "flex",
          flexDirection: "column",
          fontFamily: fonts.length ? "Inter" : undefined,
          height: "100%",
          width: "100%",
        }}
      >
        <div
          style={{
            display: "flex",
            flex: 1,
            flexDirection: "column",
            padding: "60px 72px 0",
          }}
        >
          <div
            style={{
              alignItems: "center",
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            <div style={{ alignItems: "center", display: "flex", gap: 20 }}>
              {logo.mark ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img alt="" height={66} src={logo.mark} width={103} />
              ) : null}
              {logo.wordmark ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img alt={PLATFORM_NAME} height={46} src={logo.wordmark} width={324} />
              ) : (
                <span style={{ color: INK, fontSize: 46, fontWeight: 800 }}>{PLATFORM_NAME}</span>
              )}
            </div>
            <div
              style={{
                border: `2px solid ${LINE}`,
                borderRadius: 999,
                color: MUTED,
                display: "flex",
                fontSize: 24,
                fontWeight: 600,
                padding: "8px 22px",
              }}
            >
              {host}
            </div>
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              marginBottom: 54,
              marginTop: "auto",
            }}
          >
            {eyebrow ? (
              <div
                style={{
                  color: BRAND,
                  display: "flex",
                  fontSize: 26,
                  fontWeight: 800,
                  letterSpacing: 3,
                  marginBottom: 18,
                  textTransform: "uppercase",
                }}
              >
                {eyebrow}
              </div>
            ) : null}
            <div
              style={{
                color: INK,
                display: "flex",
                fontSize: titleSize(title),
                fontWeight: 800,
                letterSpacing: -1.5,
                lineHeight: 1.08,
              }}
            >
              {title}
            </div>
          </div>
        </div>

        <div
          style={{
            alignItems: "center",
            background: BRAND,
            borderTopLeftRadius: 36,
            borderTopRightRadius: 36,
            color: "#ffffff",
            display: "flex",
            fontSize: 26,
            fontWeight: 600,
            justifyContent: "space-between",
            padding: "14px 24px 14px 72px",
          }}
        >
          <span>Hostels · Hostel management system · Nepal</span>
          <div
            style={{
              alignItems: "center",
              background: "#ffffff",
              borderRadius: 999,
              display: "flex",
              gap: 12,
              padding: "4px 24px 4px 26px",
            }}
          >
            <span style={{ color: MUTED, fontSize: 22, fontWeight: 600 }}>A product of</span>
            {logo.softmato ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img alt={PLATFORM_VENDOR} height={96} src={logo.softmato} width={128} />
            ) : (
              <span style={{ color: INK, fontSize: 24, fontWeight: 800 }}>{PLATFORM_VENDOR}</span>
            )}
          </div>
        </div>
      </div>
    ),
    { fonts, height: 630, width: 1200 },
  );
}
