import { Fragment } from "react";

import { AppBar } from "@/components/ui/app-bar";
import { Card } from "@/components/ui/card";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";

/** Finance settings → How bills work: the billing rules, one row each (E4). */
const RULES = [
  { icon: "person-add", subtitle: "To the month end, or a whole month on Same day", title: "First bill at registration" },
  { icon: "calendar", subtitle: "On the 1st, or on their own day", title: "Then one bill a month" },
  { icon: "alarm", subtitle: "On the bill's last day, or after the late-fine free days", title: "Due" },
  { icon: "notifications", subtitle: "7 and 5 days before, then twice a day from 3 days until paid", title: "Reminders" },
  { icon: "door", subtitle: "They pick the day, rent stops on it, the warden moves them out", title: "Leaving" },
] as const;

export default function HowBillsWorkScreen() {
  return (
    <Screen header={<AppBar accent centerTitle showBack title="How bills work" />} scroll>
      <Card padding="px-4 py-1">
        {RULES.map((rule, index) => (
          <Fragment key={rule.title}>
            {index > 0 ? <RowDivider inset /> : null}
            <ListRow icon={rule.icon} subtitle={rule.subtitle} title={rule.title} />
          </Fragment>
        ))}
      </Card>
    </Screen>
  );
}
