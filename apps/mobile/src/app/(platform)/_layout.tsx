import { RoleTabs, type TabDef } from "@/components/role-tabs";

/**
 * The superadmin's own shell (owner, 2026-11-03: "majority of task can be done
 * from the app via superadmin"). Until then SUPERADMIN landed on the browse app.
 *
 * Built from `PLATFORM_NAV` (`apps/web/src/lib/portal-nav.ts`) the way the admin
 * tabs mirror that file's admin groups: Home is the Overview group with its
 * System children as tiles, Community sits dead centre as in every signed-in
 * role, and More holds the rest of the platform groups.
 */
const TABS: readonly TabDef[] = [
  { icon: "home", label: "Home", name: "index" },
  { icon: "chatbubbles", label: "Community", name: "community" },
  { icon: "grid", label: "More", name: "more" },
];

export default function PlatformLayout() {
  return <RoleTabs accent="PLATFORM" tabs={TABS} />;
}
