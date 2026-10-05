/**
 * Puts a service that ships in the code's default Plans catalogue onto the live
 * site, with its name, blurb, plan, "Used by" and what / how / why.
 *
 * ## Why this exists
 *
 * The saved `plans` section replaces the defaults wholesale, so a service added
 * in `plans.defaults.ts` never reaches the live pricing page on its own. Adding
 * it by hand in Website Config → Plans gives it the address
 * `/plans-pricing/new-service` for good (a slug is fixed once created) and none
 * of the written explainer.
 *
 * ## What it changes
 *
 * Only what you name. With no names it lists what the code has and the live site
 * does not, and writes nothing — a default service missing from the live site
 * may have been removed on purpose. A named service already on the live site is
 * left exactly as edited. Each one lands after the last service of its module.
 * The result is checked against the same schema the editor saves through: a
 * section that fails it would silently fall back to the defaults on every read.
 *
 *   npm run sync:plan-services -w apps/web -- --dry-run inventory-management
 *   npm run sync:plan-services -w apps/web -- inventory-management
 */
import nextEnv from "@next/env";
import mongoose from "mongoose";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_PLANS } from "../src/modules/platform-config/plans.defaults.ts";
import { plansSchema } from "../src/modules/platform-config/site-config.validation.ts";

const dirname = path.dirname(fileURLToPath(import.meta.url));

nextEnv.loadEnvConfig(path.resolve(dirname, "../../.."));

if (!process.env.MONGODB_URI) {
  throw new Error("MONGODB_URI is required.");
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run") || args.includes("--dry");
const wanted = args.filter((arg) => !arg.startsWith("--"));

async function main() {
  const db = mongoose.connection.db;
  const settings = db.collection("platformsettings");
  const record = await settings.findOne({ key: "plans" });

  if (!record) {
    console.log("No saved Plans config: the live site already serves the defaults, every service included.");
    return;
  }

  const stored = plansSchema.safeParse(record.value);

  if (!stored.success) {
    console.log("The saved Plans config fails its own schema, so the live site is serving the defaults already.");
    console.log(`First problem: ${stored.error.issues[0]?.path.join(".")} — ${stored.error.issues[0]?.message}`);
    return;
  }

  const catalog = stored.data;
  const live = new Set(catalog.services.map((service) => service.slug));
  const missing = DEFAULT_PLANS.services.filter((service) => !live.has(service.slug));

  console.log(
    missing.length > 0
      ? `In the code but not on the live site:\n${missing
          .map((service) => `  ${service.slug} — ${service.name} (${service.plan})`)
          .join("\n")}`
      : "Every default service is already on the live site.",
  );

  if (wanted.length === 0) {
    if (missing.length > 0) console.log("\nName the ones to add, e.g.  -- inventory-management");
    return;
  }

  const adding = [];

  for (const slug of wanted) {
    const service = missing.find((entry) => entry.slug === slug);

    if (!service) {
      console.log(`${slug}: ${live.has(slug) ? "already on the live site, left as it is" : "not a default service"}`);
      continue;
    }

    if (!catalog.modules.some((module) => module.id === service.module)) {
      console.log(`${slug}: the live site has no "${service.module}" module — skipped`);
      continue;
    }

    if (!catalog.plans.some((plan) => plan.id === service.plan)) {
      console.log(`${slug}: the live site has no "${service.plan}" plan — skipped`);
      continue;
    }

    adding.push(service);
  }

  if (adding.length === 0) return;

  const services = [...catalog.services];

  for (const service of adding) {
    services.splice(services.findLastIndex((entry) => entry.module === service.module) + 1, 0, service);
  }

  const next = plansSchema.safeParse({ ...catalog, services });

  if (!next.success) {
    console.error(`Not saved — the result fails the schema: ${next.error.issues[0]?.path.join(".")} ${next.error.issues[0]?.message}`);
    process.exitCode = 1;
    return;
  }

  console.log("");

  for (const service of adding) {
    const module = catalog.modules.find((entry) => entry.id === service.module);

    console.log(`+ ${service.name} — ${module?.name ?? service.module}, ${service.plan} plan, /plans-pricing/${service.slug}`);
  }

  if (dryRun) {
    console.log("\nDry run: nothing saved.");
    return;
  }

  const at = new Date();

  await settings.updateOne({ _id: record._id }, { $set: { updatedAt: at, value: next.data } });
  await db.collection("auditlogs").insertOne({
    action: "PLATFORM_SITE_CONFIG_UPDATED",
    actorId: null,
    actorType: "SYSTEM",
    createdAt: at,
    entityId: "plans",
    entityType: "PlatformSetting",
    metadata: { addedServices: adding.map((service) => service.slug), section: "plans" },
    updatedAt: at,
  });

  // A direct write skips the editor's `revalidatePath`, so cached website pages
  // (including a service page prerendered as a 404) wait for their window.
  console.log(
    "\nSaved. The API and the app see it within a minute. Cached website pages refresh within the hour —" +
      "\nor at once on the next Save in Website Config.",
  );
}

await mongoose.connect(process.env.MONGODB_URI);

try {
  await main();
} finally {
  await mongoose.disconnect();
}
