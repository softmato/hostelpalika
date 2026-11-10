import { RoleTabs, type TabDef } from "@/components/role-tabs";

/**
 * The superadmin's own shell (owner, 2026-11-03: "majority of task can be done
 * from the app via superadmin"; 2026-11-09: "do all the task cleanly that i need
 * to do from laptop").
 *
 * Built from `PLATFORM_NAV` (`apps/web/src/lib/portal-nav.ts`): Home is the
 * Overview group (what needs a decision today), Hostels is the approval queue
 * and listings, Money is plan billing, payment proofs, field cash and supply
 * store orders, System is the server's own health (owner 2026-11-09: its own
 * tab), and More holds People and the rest. Community is reached from More.
 */
const TABS: readonly TabDef[] = [
  { icon: "home", label: "Home", name: "index" },
  { icon: "hostel", label: "Hostels", name: "approvals" },
  { icon: "wallet", label: "Money", name: "money" },
  { icon: "pulse", label: "System", name: "system" },
  { icon: "grid", label: "More", name: "more" },
];

export default function PlatformLayout() {
  return <RoleTabs accent="PLATFORM" hidden={["community"]} tabs={TABS} />;
}
