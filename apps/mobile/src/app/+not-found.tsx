import { router } from "expo-router";

import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/states";
import { Screen } from "@/components/ui/screen";

export default function NotFoundScreen() {
  return (
    <Screen header={<AppBar showBack title="Not found" />}>
      <EmptyState icon="help-circle"
        action={<Button label="Go home" onPress={() => router.replace("/")} />}
        description="That link points somewhere this version of the app doesn't have."
        title="Screen not found"
      />
    </Screen>
  );
}
