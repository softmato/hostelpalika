import { apiBreaker } from "@/lib/api";

/** One cheap health read (5 s cap): true when the server answered. */
export async function serverAnswers() {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 5000);

  try {
    const response = await fetch(`${apiBreaker.origin()}/api/v1/health`, { signal: abort.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
