import type { LucideProps } from "lucide-react";
import { createElement } from "react";

import { contentIcon } from "@/lib/site-content";

/**
 * A config-chosen icon, by slug. `createElement` rather than `<Icon />`: the
 * slug resolves through a fixed module-level map, so the component is stable,
 * but the React compiler cannot see that through a function call and treats
 * `const Icon = contentIcon(…)` in a render as a component created there.
 */
export function ContentIcon({ slug, ...props }: LucideProps & { slug: string }) {
  return createElement(contentIcon(slug), props);
}
