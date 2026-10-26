import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PublicRolePage } from "@/app/_components/public-role-page";
import { JsonLd } from "@/components/json-ld";
import { breadcrumbJsonLd, faqJsonLd } from "@/lib/json-ld";
import { ROLE_LOCK_NOTE, ROLE_PAGES, rolePage } from "@/lib/role-pages";
import { NOINDEX, pageMetadata } from "@/lib/seo";

type PageParams = {
  params: Promise<{ role: string }>;
};

export const dynamicParams = false;

export function generateStaticParams() {
  return ROLE_PAGES.map((page) => ({ role: page.slug }));
}

/** "Hostel warden app", "hostel app for parents" — see `lib/role-pages.ts`. */
export async function generateMetadata({ params }: PageParams): Promise<Metadata> {
  const page = rolePage((await params).role);

  if (!page) {
    return { robots: NOINDEX, title: "Not found" };
  }

  return pageMetadata({
    description: page.description,
    eyebrow: `For ${page.label.toLowerCase()}`,
    path: `/for/${page.slug}`,
    title: page.title,
  });
}

export default async function RolePageRoute({ params }: PageParams) {
  const page = rolePage((await params).role);

  if (!page) {
    notFound();
  }

  const path = `/for/${page.slug}`;

  return (
    <>
      <JsonLd
        data={[
          breadcrumbJsonLd([
            { name: "Home", path: "/" },
            { name: "Hostel management software", path: "/hostel-management-software" },
            { name: `For ${page.label.toLowerCase()}`, path },
          ]),
          faqJsonLd(page.faq),
        ]}
      />
      <PublicRolePage
        lockNote={ROLE_LOCK_NOTE}
        others={ROLE_PAGES.filter((entry) => entry.slug !== page.slug).map((entry) => ({
          href: `/for/${entry.slug}`,
          label: `For ${entry.label.toLowerCase()}`,
        }))}
        page={page}
      />
    </>
  );
}
