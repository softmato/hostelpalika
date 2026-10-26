import { loadLlmsData } from "@/lib/llms-data";
import { buildLlmsTxt } from "@/lib/llms-txt";

export const runtime = "nodejs";
// Hourly, like the sitemap: new hostels appear without a redeploy.
export const revalidate = 3600;

/** `/llms.txt` — see `lib/llms-txt.ts` for what it is and is not for. */
export async function GET() {
  return new Response(buildLlmsTxt(await loadLlmsData()), {
    headers: {
      // Plain text so a browser shows it rather than downloading it; the body
      // is Markdown, which is what llms.txt readers expect.
      "Content-Type": "text/plain; charset=utf-8",
      // For tools to read, not a search result of its own: the pages it links
      // to are the ones that should rank.
      "X-Robots-Tag": "noindex",
    },
  });
}
