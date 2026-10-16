import type { IconComponent } from "@/components/icons";
import Link from "next/link";

type PortalPlaceholderAction = {
  href: string;
  label: string;
};

type PortalPlaceholderPageProps = {
  actions?: PortalPlaceholderAction[];
  description: string;
  icon: IconComponent;
  items: string[];
  title: string;
};

export function PortalPlaceholderPage({
  actions = [],
  description,
  icon: Icon,
  items,
  title,
}: PortalPlaceholderPageProps) {
  return (
    <div className="mx-auto max-w-[960px] space-y-6">
      <div className="flex items-start gap-3">
        <span className="rounded-lg bg-muted p-3 text-foreground">
          <Icon className="size-5" />
        </span>
        <div>
          <h1 className="font-heading text-3xl font-bold text-foreground">{title}</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{description}</p>
        </div>
      </div>

      <section className="rounded-lg border border-border bg-surface p-5 shadow-sm">
        <div className="grid gap-3 sm:grid-cols-2">
          {items.map((item) => (
            <div className="rounded-md border border-border bg-background p-4" key={item}>
              <p className="text-sm font-semibold text-foreground">{item}</p>
            </div>
          ))}
        </div>
      </section>

      {actions.length > 0 ? (
        <div className="flex flex-wrap gap-3">
          {actions.map((action, index) => (
            <Link
              className={
                index === 0
                  ? "inline-flex h-11 items-center justify-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground"
                  : "inline-flex h-11 items-center justify-center rounded-md border border-border px-4 text-sm font-semibold text-foreground"
              }
              href={action.href}
              key={action.href}
            >
              {action.label}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}
