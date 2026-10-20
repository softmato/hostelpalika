import { describe, expect, it } from "vitest";

import { withEtag } from "./etag";

const json = () => Response.json({ data: [1, 2, 3], success: true });

describe("withEtag", () => {
  it("tags a JSON GET and answers 304 when the client already holds that body", async () => {
    const first = await withEtag(new Request("https://x.test/a"), json());
    const etag = first.headers.get("etag");

    expect(first.status).toBe(200);
    expect(etag).toMatch(/^W\/"/);

    const again = await withEtag(new Request("https://x.test/a", { headers: { "if-none-match": etag! } }), json());

    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
  });

  it("sends the body when it changed, and leaves non-GETs alone", async () => {
    const changed = await withEtag(
      new Request("https://x.test/a", { headers: { "if-none-match": 'W/"stale"' } }),
      json(),
    );
    const post = await withEtag(new Request("https://x.test/a", { method: "POST" }), json());

    expect(changed.status).toBe(200);
    expect(post.headers.get("etag")).toBeNull();
  });
});
