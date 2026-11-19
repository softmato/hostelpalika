import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useState } from "react";

import { useResource } from "@/hooks/use-resource";
import { getGuide, type GuideResponse } from "@/lib/guide-api";

/**
 * The guide for this account, shared by the Guide screens. Kept a few hours at
 * most: the pictures carry signatures that end after six.
 */
export function useGuide() {
  return useResource<GuideResponse>(useCallback(() => getGuide(), []), {
    cacheKey: "guide",
    maxAgeMs: 5 * 60 * 60 * 1000,
    staleMs: 30 * 60 * 1000,
  });
}

export type GuideLang = "en" | "ne";

const LANG_KEY = "guide:lang";
let remembered: GuideLang = "en";
void AsyncStorage.getItem(LANG_KEY)
  .then((v) => {
    if (v === "ne") remembered = "ne";
  })
  .catch(() => null);

/** English or नेपाली, remembered on this phone (read at app start, long before the guide opens). */
export function useGuideLang() {
  const [lang, setLang] = useState<GuideLang>(remembered);
  const choose = useCallback((next: GuideLang) => {
    remembered = next;
    setLang(next);
    AsyncStorage.setItem(LANG_KEY, next).catch(() => null);
  }, []);
  return [lang, choose] as const;
}

export const GUIDE_LANG_OPTIONS = [
  { label: "English", value: "en" },
  { label: "नेपाली", value: "ne" },
] as const;
