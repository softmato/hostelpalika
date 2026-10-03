import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { expect, it } from "vitest";
const require = createRequire(import.meta.url);
const projectRoot = resolve(import.meta.dirname, "../..");

it("replaces the generated iOS extension after Expo and provisions its shared Keychain", async () => {
  const directory = mkdtempSync(join(tmpdir(), "receipt-plugin-"));
  try {
    const sharing = require("expo-sharing/app.plugin");
    const receipt = require("../../plugins/withReceiptSheet");
    const config = receipt((sharing.default || sharing)({ _internal: { projectRoot }, name: "Test", slug: "test", ios: { bundleIdentifier: "com.softmato.hostelpalika" }, scheme: "hostelpalika" }, { ios: { enabled: true, appGroupId: "group.com.softmato.hostelpalika", activationRule: { supportsImageWithMaxCount: 1, supportsFileWithMaxCount: 1 } } }));
    await config.mods.ios.dangerous({ ...config, modResults: {}, modRequest: { projectRoot, platformProjectRoot: directory, platform: "ios", modName: "dangerous" } });
    const extension = join(directory, "expo-sharing-extension");
    const source = readFileSync(join(extension, "ShareIntoViewController.swift"), "utf8");
    expect(source).toContain("WKScriptMessageHandler");
    expect(source).toContain("enum ReceiptCore");
    expect(source).toContain("private let receiptMarkup");
    expect(source).not.toContain("class ShareIntoViewController: SLComposeServiceViewController");
    expect(readFileSync(join(extension, "Info.plist"), "utf8")).toContain("ReceiptKeychainGroup");
    expect(readFileSync(join(extension, "expo-sharing-extension.entitlements"), "utf8")).toContain("keychain-access-groups");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it("removes the full-app SEND target after Expo adds its intent filters", async () => {
  const sharing = require("expo-sharing/app.plugin");
  const receipt = require("../../plugins/withReceiptSheet");
  const config = receipt((sharing.default || sharing)({ _internal: { projectRoot }, name: "Test", slug: "test", ios: { bundleIdentifier: "com.softmato.hostelpalika" }, scheme: "hostelpalika" }, { android: { enabled: true, singleShareMimeTypes: ["application/pdf"] } }));
  const activity = { $: { "android:name": ".MainActivity" }, "intent-filter": [{ action: [{ $: { "android:name": "android.intent.action.VIEW" } }] }] };
  const result = await config.mods.android.manifest({ ...config, modResults: { manifest: { application: [{ activity: [activity] }] } }, modRequest: { projectRoot, platform: "android", modName: "manifest" } });
  expect(JSON.stringify(result.modResults)).not.toContain("android.intent.action.SEND");
  expect(JSON.stringify(result.modResults)).toContain("android.intent.action.VIEW");
});
