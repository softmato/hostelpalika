/**
 * Asks before the page unloads while `active`. A phone app has no page to
 * unload — leaving a screen is `usePreventRemove`'s job — so this is a no-op
 * here and the PWA's stand-in (`web/unload-guard.ts`) does the work.
 */
export function useUnloadGuard(_active: boolean) {}
