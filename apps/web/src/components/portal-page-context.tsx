"use client";

import { createContext, useContext } from "react";

import type { GlyphName } from "@/components/glyph";

/**
 * The active nav destination's glyph, provided by `PortalShell`, so a page's
 * header block can wear the same mark as its sidebar row without every page
 * naming its own icon.
 */
const PortalPageIconContext = createContext<GlyphName | null>(null);

export const PortalPageIconProvider = PortalPageIconContext.Provider;

export function usePortalPageIcon() {
  return useContext(PortalPageIconContext);
}
