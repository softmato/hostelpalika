"use client";

import { PublicShell } from "@/app/_components/shared";
import { useSiteConfig } from "@/components/site-config-provider";
import { Calendar, Clock, Tag, User } from "@/components/icons";

const buildPosts = (siteName: string) => [
  {
    title: "How to Choose the Perfect Hostel in Kathmandu",
    excerpt:
      "From location to facilities — a complete guide for students and parents looking for the ideal accommodation in the valley.",
    author: `${siteName} Team`,
    date: "July 8, 2026",
    readTime: "5 min read",
    category: "Guides",
    image:
      "https://images.unsplash.com/photo-1555854877-bab0e564b8d5?auto=format&fit=crop&w=800&q=80",
  },
  {
    title: "Top 10 Facilities to Look for in a Student Hostel",
    excerpt:
      "Wi-Fi, food quality, security, and more — here is what every student should check before moving into a hostel.",
    author: `${siteName} Team`,
    date: "July 5, 2026",
    readTime: "7 min read",
    category: "Tips",
    image:
      "https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?auto=format&fit=crop&w=800&q=80",
  },
  {
    title: "Understanding Hostel Fee Structures in Nepal",
    excerpt:
      "Breaking down rent, deposits, meal plans, and hidden costs so you can budget with confidence.",
    author: `${siteName} Team`,
    date: "July 1, 2026",
    readTime: "6 min read",
    category: "Finance",
    image:
      "https://images.unsplash.com/photo-1554224155-8d04cb21cd6c?auto=format&fit=crop&w=800&q=80",
  },
  {
    title: "A Day in the Life of a Hostel Resident",
    excerpt:
      "From morning routines to late-night study sessions — experience what life is really like in a Nepali student hostel.",
    author: `${siteName} Team`,
    date: "June 28, 2026",
    readTime: "4 min read",
    category: "Lifestyle",
    image:
      "https://images.unsplash.com/photo-1523050854058-8df90110c7f1?auto=format&fit=crop&w=800&q=80",
  },
  {
    title: "Why Hostel Verification Matters for Parents",
    excerpt:
      `Learn how ${siteName} verified listings give families peace of mind when sending their children to a new city.`,
    author: `${siteName} Team`,
    date: "June 22, 2026",
    readTime: "5 min read",
    category: "Trust & Safety",
    image:
      "https://images.unsplash.com/photo-1581578731548-c64695cc6952?auto=format&fit=crop&w=800&q=80",
  },
  {
    title: "Comparing Hostels vs. Renting a Private Room",
    excerpt:
      "Cost, convenience, community — a balanced look at the pros and cons of hostel living versus private renting in Nepal.",
    author: `${siteName} Team`,
    date: "June 18, 2026",
    readTime: "8 min read",
    category: "Guides",
    image:
      "https://images.unsplash.com/photo-1560518883-ce09059eeffa?auto=format&fit=crop&w=800&q=80",
  },
];

export function PublicBlogPage() {
  const siteName = useSiteConfig().identity.siteName;
  const posts = buildPosts(siteName);

  return (
    <PublicShell>
      <div className="mx-auto max-w-5xl px-6 py-20">
        {/* Header */}
        <div className="mb-16 text-center">
          <div className="mx-auto mb-5 flex size-14 items-center justify-center rounded-2xl bg-primary/10">
            <Calendar className="size-7 text-primary" />
          </div>
          <h1 className="font-heading text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
            Blog
          </h1>
          <p className="mt-3 text-muted-foreground">
            Tips, guides, and updates from the {siteName} team
          </p>
          <div className="mx-auto mt-4 h-px max-w-xs bg-border" />
        </div>

        {/* Posts */}
        <div className="grid gap-8 md:grid-cols-2">
          {posts.map((post) => (
            <article
              key={post.title}
              className="group overflow-hidden rounded-xl border border-border bg-surface shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
            >
              <div
                className="h-48 bg-cover bg-center"
                style={{ backgroundImage: `url("${post.image}")` }}
              />
              <div className="p-5">
                <div className="mb-3 flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-0.5 font-medium text-primary">
                    <Tag className="size-3" />
                    {post.category}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Clock className="size-3" />
                    {post.readTime}
                  </span>
                </div>
                <h2 className="font-heading text-lg font-semibold text-foreground group-hover:text-primary transition-colors">
                  {post.title}
                </h2>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {post.excerpt}
                </p>
                <div className="mt-4 flex items-center justify-between border-t border-border pt-4 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <User className="size-3" />
                    {post.author}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Calendar className="size-3" />
                    {post.date}
                  </span>
                </div>
              </div>
            </article>
          ))}
        </div>
      </div>
    </PublicShell>
  );
}
