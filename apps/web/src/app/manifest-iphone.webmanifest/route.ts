import { webManifest } from "@/lib/web-manifest";

/** The iPhone copy of `/manifest.webmanifest`; next.config.ts rewrites to it by user agent. */
export const revalidate = 86400;

export async function GET() {
  return Response.json(await webManifest("iphone"), { headers: { "Content-Type": "application/manifest+json" } });
}
