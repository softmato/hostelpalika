import type { Metadata } from "next";
import Link from "next/link";

import { PublicFooter } from "@/components/public-footer";
import { PublicHeader } from "@/components/public-header";

export const metadata: Metadata = { robots: { follow: false, index: false }, title: "Page not found" };

/** Every unmatched URL and every `notFound()` that has no closer boundary. */
export default function NotFound() {
  return (
    <>
      <PublicHeader />
      <main className="mx-auto flex min-h-[60vh] max-w-lg flex-col items-center justify-center px-6 text-center">
        <p className="font-heading text-6xl font-extrabold text-primary">404</p>
        <h1 className="mt-3 font-heading text-2xl font-extrabold text-foreground">Page not found</h1>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link
            className="inline-flex h-11 items-center justify-center rounded-lg bg-brand-teal px-5 text-sm font-bold text-white transition hover:brightness-105"
            href="/"
          >
            Go home
          </Link>
          <Link
            className="inline-flex h-11 items-center justify-center rounded-lg border border-border px-5 text-sm font-bold text-foreground transition hover:bg-muted"
            href="/hostels"
          >
            Find hostels
          </Link>
        </div>
      </main>
      <PublicFooter />
    </>
  );
}
