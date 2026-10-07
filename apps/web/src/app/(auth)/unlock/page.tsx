import type { Metadata } from "next";

import { UnlockForm } from "./unlock-form";

export const metadata: Metadata = { title: "Enter your PIN" };

/** Where `proxy.ts` sends a browser whose account has an app-lock PIN it has not typed yet. */
export default function UnlockPage() {
  return <UnlockForm />;
}
