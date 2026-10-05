import { Redirect } from "expo-router";
import { useEffect, useState } from "react";

import { OVERALL, setActiveHostelId } from "@/lib/active-hostel";

/**
 * Overall used to be its own screen. It is now a branch you pick in the
 * switcher, and the tabs answer for every branch at once
 * (`components/overall-views.tsx`). This route stays only so an old link or a
 * notification still lands somewhere: it picks Overall and goes Home.
 */
export default function OverallRedirect() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void setActiveHostelId(OVERALL).then(() => setReady(true));
  }, []);

  return ready ? <Redirect href="/(admin)" /> : null;
}
