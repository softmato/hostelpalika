import { api } from "@/lib/api";
import { type ApiEnvelope, unwrap } from "@/lib/api-contract";

/**
 * `GET /api/v1/guide` — the user guide as this account may read it. The words
 * are private (packages/shared/src/guide/guide.ts says why), so the app never
 * carries them: the server sends only this role's chapters and signs each
 * picture for a few hours. Types mirror `GuideContent` in that file.
 */
export type GuidePicture = { caption: string; name?: string; src: string };

export type GuideChapter = {
  id: string;
  title: string;
  summary: string;
  body?: string[];
  points?: string[];
  steps?: string[];
  note?: { title: string; body: string };
  shot?: GuidePicture;
  flow?: GuidePicture;
  widget?: "share-receipt" | "access-table" | "troubleshooting" | "auto-billing";
};

export type GuideGroup = { slug: string; label: string; intro: string; chapters: GuideChapter[] };

export type GuideChapterNe = Partial<Pick<GuideChapter, "body" | "points" | "steps" | "note">> & {
  title: string;
  summary: string;
  flow?: string;
  shot?: string;
};

type Role = "owner" | "warden" | "resident" | "guardian" | "cook";

export type Guide = {
  groups: GuideGroup[];
  access: { area: string; cells: Record<Role, string> }[];
  trouble: { problem: string; fix: string }[];
  ne: {
    groups: Record<string, { label: string; intro: string }>;
    chapters: Record<string, GuideChapterNe>;
    access: { areas: Record<string, string>; cells: Record<string, string>; roles: Record<string, string> };
    trouble: { problem: string; fix: string }[];
  };
};

export type GuideResponse = { guide: Guide; reader: string; updatedAt: string; version: string };

export async function getGuide() {
  return unwrap(await api.get<ApiEnvelope<GuideResponse>>("/guide"));
}

export const GUIDE_ROLES: readonly Role[] = ["owner", "warden", "resident", "guardian", "cook"];
