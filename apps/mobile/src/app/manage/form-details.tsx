import { FormDetailsSettings } from "@/components/manage/form-details-settings";
import { AppBar } from "@/components/ui/app-bar";
import { Screen } from "@/components/ui/screen";

/** Settings → Admission form: which documents the form insists on. */
export default function FormDetailsScreen() {
  return (
    <Screen header={<AppBar accent centerTitle showBack title="Admission form" />} scroll>
      <FormDetailsSettings />
    </Screen>
  );
}
