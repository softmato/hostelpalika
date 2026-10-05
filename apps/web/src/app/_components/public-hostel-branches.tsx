import Image from "next/image";
import Link from "next/link";
import { ArrowRight, Building2, MapPin } from "lucide-react";
import type { PublicBranch } from "@hostel/shared/types/public-branch";

export function PublicHostelBranches({ branches }: { branches: PublicBranch[] }) {
  if (!branches.length) return null;
  return (
    <section
      id="hostel-branches"
      aria-labelledby="other-branches-title"
      className="scroll-mt-28 rounded-lg border border-border bg-surface p-5 shadow-sm"
    >
      <h2 id="other-branches-title" className="text-xl font-extrabold text-foreground">
        Other branches
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        More locations from the same hostel owner. Explore each branch&apos;s photos, rooms and
        facilities.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {branches.map((branch) => (
          <Link
            key={branch.id}
            href={`/map?slug=${encodeURIComponent(branch.slug)}`}
            className="group flex items-center gap-3 rounded-xl border border-border bg-background p-3 transition-colors hover:border-brand-teal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-teal"
          >
            <div className="relative flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted">
              {branch.photoUrl ? (
                <Image
                  src={branch.photoUrl}
                  alt={`${branch.name} exterior`}
                  fill
                  sizes="80px"
                  className="object-cover"
                  unoptimized
                />
              ) : (
                <Building2 className="size-7 text-muted-foreground" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="font-bold text-foreground">{branch.name}</h3>
              <p className="mt-1 flex items-start gap-1 text-xs text-muted-foreground">
                <MapPin className="size-3.5 shrink-0" />
                {[branch.area, branch.city].filter(Boolean).join(", ")}
              </p>
              <span className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-brand-teal">
                View on map <ArrowRight className="size-3.5" />
              </span>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
