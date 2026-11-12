import { useResource } from "@/hooks/use-resource";
import { type ManagedHostel } from "@/lib/admin-manage-api";
import { adminQuery } from "@/lib/admin-queries";

/** The listing's photos, cached with Rooms — so what is added here is there too. */
export function useManagedHostel() {
  const query = adminQuery.managedHostel();

  return useResource<ManagedHostel>(query.load, { cacheKey: query.key, topics: query.topics });
}
