export function withSessionRefreshLock<T>(work: () => Promise<T>): Promise<T> { return work(); }
