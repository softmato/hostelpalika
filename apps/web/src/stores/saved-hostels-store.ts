import { create } from "zustand";
import { persist } from "zustand/middleware";

import { browserApi } from "@/lib/browser-api";
import { useSessionStore } from "@/stores/session-store";

type SavedHostelsStore = {
  ids: string[];
  /** Hearts / un-hearts at once; the server catches up in the background when signed in. */
  toggle: (id: string) => void;
};

const save = (body: { add?: string[]; remove?: string[] }) =>
  browserApi("/api/v1/account/saved-hostels", { body: JSON.stringify(body), method: "POST" }).catch(() => {});

/**
 * Hearted hostels. Held in localStorage so a visitor who is not signed in keeps
 * them; once signed in, `syncSavedHostels` merges them into the account.
 */
export const useSavedHostelsStore = create<SavedHostelsStore>()(
  persist(
    (set, get) => ({
      ids: [],
      toggle: (id) => {
        const saved = get().ids.includes(id);

        set({ ids: saved ? get().ids.filter((value) => value !== id) : [...get().ids, id] });

        if (useSessionStore.getState().user) {
          void save(saved ? { remove: [id] } : { add: [id] });
        }
      },
    }),
    { name: "hostelpalika-saved-hostels" },
  ),
);

let syncedFor = "";

/** Binds the browser's hearts to the account once per sign-in, then adopts the account's list. */
export async function syncSavedHostels(userId: string) {
  if (syncedFor === userId) return;
  syncedFor = userId;

  try {
    const { ids } = await browserApi<{ ids: string[] }>("/api/v1/account/saved-hostels", {
      body: JSON.stringify({ add: useSavedHostelsStore.getState().ids }),
      method: "POST",
    });

    useSavedHostelsStore.setState({ ids });
  } catch {
    syncedFor = "";
  }
}
