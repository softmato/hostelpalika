import { createContext, useContext, useId, useLayoutEffect, useRef } from "react";

export type KycDraft = {
  dirty: boolean;
  busy?: boolean;
  save: () => Promise<boolean>;
};
export type DraftRegistration = (id: string, draft: KycDraft | null) => void;
export const KycDraftContext = createContext<DraftRegistration | null>(null);

/** Editors stay local; the wizard owns navigation and the one save button. */
export function useKycDraft(draft: KycDraft) {
  const register = useContext(KycDraftContext);
  const id = useId();
  const latest = useRef(draft.save);
  useLayoutEffect(() => { latest.current = draft.save; });
  useLayoutEffect(() => {
    register?.(id, { dirty: draft.dirty, busy: draft.busy, save: () => latest.current() });
    return () => register?.(id, null);
  }, [register, id, draft.dirty, draft.busy]);
  return Boolean(register);
}
