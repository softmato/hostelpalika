// Serialize rotations across PWA windows sharing localStorage.
export function withSessionRefreshLock<T>(work: () => Promise<T>): Promise<T> {
  return navigator.locks ? navigator.locks.request("hostelpalika-app-refresh", work) : work();
}
