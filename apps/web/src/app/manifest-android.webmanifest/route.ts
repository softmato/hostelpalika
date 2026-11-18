import { webManifest } from "@/lib/web-manifest";

/** The Android copy of `/manifest.webmanifest`; next.config.ts rewrites to it by user agent. */
export const revalidate = 86400;

export async function GET() {
  return Response.json(await webManifest("android"), { headers: { "Content-Type": "application/manifest+json" } });
}
