import { RoleTabs, type TabDef } from "@/components/role-tabs";

/**
 * The superadmin's own shell (owner, 2026-11-03: "majority of task can be done
 * from the app via superadmin"). Until then SUPERADMIN landed on the browse app.
 *
 * Built from `PLATFORM_NAV` (`apps/web/src/lib/portal-nav.ts`) the way the admin
 * tabs mirror that file's admin groups: Home is the Overview group with its
 * Active users and Analytics as tiles, System holds the server's own health
 * (logs, process, cron; owner 2026-11-09: its own tab), Community as in every
 * signed-in role, and More holds the rest of the platform groups.
 */
const TABS: readonly TabDef[] = [
  { icon: "home", label: "Home", name: "index" },
  { icon: "pulse", label: "System", name: "system" },
  { icon: "chatbubbles", label: "Community", name: "community" },
  { icon: "grid", label: "More", name: "more" },
];

export default function PlatformLayout() {
  return <RoleTabs accent="PLATFORM" tabs={TABS} />;
}
