const fs = require('fs');
const path = require('path');
const plist = require('@expo/plist').default;
const { withBaseMod, withInfoPlist, withEntitlementsPlist } = require('@expo/config-plugins');

/** Keep Expo's generated/signed extension target, replace only its controller. */
module.exports = function withReceiptSheet(config) {
  const group = `$(AppIdentifierPrefix)${config.ios.bundleIdentifier}.receipts`;
  config = withInfoPlist(config, c => { c.modResults.ReceiptKeychainGroup = group; return c; });
  config = withEntitlementsPlist(config, c => {
    c.modResults['keychain-access-groups'] = [...new Set([...(c.modResults['keychain-access-groups'] || []), group])];
    return c;
  });
  // EAS must provision both the containing app and its extension for shared Keychain access.
  const extensions = config.extra?.eas?.build?.experimental?.ios?.appExtensions || [];
  for (const extension of extensions) {
    if (extension.targetName === 'expo-sharing-extension') {
      extension.entitlements['keychain-access-groups'] = [group];
    }
  }
  config = withBaseMod(config, { platform: 'android', mod: 'manifest', async action(c) {
    c = await c.modRequest.nextMod(c);
    const main = c.modResults.manifest.application[0].activity.find(a => a.$['android:name'] === '.MainActivity');
    // Exactly one share target: our lightweight activity. MainActivity retains deep links.
    if (main) main['intent-filter'] = (main['intent-filter'] || []).filter(filter =>
      !(filter.action || []).some(action => ['android.intent.action.SEND','android.intent.action.SEND_MULTIPLE'].includes(action.$['android:name'])));
    return c;
  }});
  return withBaseMod(config, { platform: 'ios', mod: 'dangerous', async action(c) {
    // Expo's file generator must finish first, otherwise it overwrites our controller.
    c = await c.modRequest.nextMod(c);
    const root = c.modRequest.projectRoot;
    const target = path.join(c.modRequest.platformProjectRoot, 'expo-sharing-extension');
    const source = path.join(root, 'modules/receipt-sheet/ios');
    const html = fs.readFileSync(path.join(root, '../web/public/receipt-sheet.html'), 'utf8');
    const controller = fs.readFileSync(path.join(source, 'ShareIntoViewController.swift'), 'utf8');
    const core = fs.readFileSync(path.join(source, 'ReceiptCore.swift'), 'utf8');
    const markup = `\nprivate let receiptMarkup = String(data: Data(base64Encoded: "${Buffer.from(html).toString('base64')}")!, encoding: .utf8)!\n`;
    fs.writeFileSync(path.join(target, 'ShareIntoViewController.swift'), controller + '\n' + core + markup);
    const infoPath = path.join(target, 'Info.plist');
    const info = plist.parse(fs.readFileSync(infoPath, 'utf8'));
    info.ReceiptKeychainGroup = group;
    fs.writeFileSync(infoPath, plist.build(info));
    const entitlementsPath = path.join(target, 'expo-sharing-extension.entitlements');
    const entitlements = plist.parse(fs.readFileSync(entitlementsPath, 'utf8'));
    entitlements['keychain-access-groups'] = [group];
    fs.writeFileSync(entitlementsPath, plist.build(entitlements));
    return c;
  }});
};
