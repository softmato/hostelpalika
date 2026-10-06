import { RoleTabs, type TabDef } from "@/components/role-tabs";
import { usePortalWarmup } from "@/hooks/use-portal-warmup";
import { prefetchResidentPortal } from "@/lib/resident-queries";

const TABS: readonly TabDef[] = [
  { icon: "home", label: "Home", name: "index" },
  { icon: "card", label: "Payments", name: "payments" },
  { icon: "chatbubbles", label: "Community", name: "community" },
  { icon: "receipt", label: "Statement", name: "statement" },
  { icon: "grid", label: "More", name: "more" },
];

/**
 * Notices, then Food, gave up the slots Community and Statement needed.
 *
 * Both went for the same reason, and it is the reason a tab is worth having at
 * all: a notice worth reading arrives as a push and is listed on Home, and this
 * week's food is on Home too with `All meals` on it. Neither tab was a *way in*
 * to anything — each was a second way to reach something already in front of the
 * resident, holding a slot against something that had no first way.
 *
 * What took Food's is the statement of what they have actually paid. Payments
 * answers "what do I owe and how do I pay it"; a resident asked by a parent or a
 * landlord what they *have* paid was reading a list of debts to work it out.
 *
 * Both screens are unchanged and still reachable from Home and from More.
 */
const HIDDEN = ["food", "notices"] as const;

export default function RoleLayout() {
  /*
   * The portal's warm-up: Home, every tab and the screens pushed from Home, in
   * one parallel wave the moment the group mounts, refilled on foreground. See
   * `usePortalWarmup`. Nothing is awaited and nothing can throw.
   */
  usePortalWarmup(prefetchResidentPortal);

  /*
    No `<SosFab>` any more.

    It hung outside the navigator so one red circle could float over all five
    tabs — and floating is what was wrong with it: it hid on scroll with the rest
    of the bottom chrome, it covered whatever was underneath, and a circle with
    no fixed neighbours reads as decoration rather than as the alarm. SOS is now
    `<SosHeaderButton>`, a fixed seat on Home's top bar, which is the tab the app
    opens on and one tap from every other. Nothing here renders it, and nothing
    here should: two of them is two countdowns.
  */
  return <RoleTabs accent="RESIDENT" hidden={HIDDEN} tabs={TABS} />;
}
