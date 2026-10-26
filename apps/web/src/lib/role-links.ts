/**
 * The `/for/[role]` pages by slug and label — just enough for links. The footer
 * is a client component on every public page, so it imports this rather than
 * `role-pages.ts` and its paragraphs. `role-pages.test.ts` keeps the two in step.
 */
export const ROLE_LINKS = [
  { label: "Hostel owners", slug: "owners" },
  { label: "Wardens", slug: "wardens" },
  { label: "Cooks", slug: "cooks" },
  { label: "Residents", slug: "residents" },
  { label: "Parents", slug: "parents" },
] as const;
