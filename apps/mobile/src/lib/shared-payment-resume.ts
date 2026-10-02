let pending: { share?: string; error?: string } | null = null;
export function rememberPaymentShare(params: { share?: string; error?: string }) { pending = params; }
export function takePaymentShareRoute() { const value = pending; pending = null; return value; }
