const fs = require('fs');
const path = require('path');
const { withDangerousMod, withGradleProperties } = require('@expo/config-plugins');

/**
 * MapLibre's React Native module ships no consumer R8 rules, and its bridge
 * finds classes by name — a minified release would crash on the first map.
 */
const KEEP_RULES = `
# MapLibre React Native (plugins/withReleaseMinify.js)
-keep class org.maplibre.reactnative.** { *; }
`;

function withMapLibreKeepRules(config) {
  return withDangerousMod(config, ['android', async c => {
    const file = path.join(c.modRequest.platformProjectRoot, 'app', 'proguard-rules.pro');
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (!current.includes('org.maplibre.reactnative')) fs.writeFileSync(file, current + KEEP_RULES);
    return c;
  }]);
}

/**
 * R8 on release builds: Play flags a bundle whose DEX is under 25% obfuscated
 * ("DEX code optimization below threshold", deadline Feb 2027). The RN template's
 * app/build.gradle reads these two properties — the same ones expo-build-properties
 * writes, without adding that package. Debug builds are untouched.
 */
module.exports = function withReleaseMinify(config) {
  config = withMapLibreKeepRules(config);
  return withGradleProperties(config, c => {
    for (const key of ['android.enableMinifyInReleaseBuilds', 'android.enableShrinkResourcesInReleaseBuilds']) {
      c.modResults = c.modResults.filter(item => !(item.type === 'property' && item.key === key));
      c.modResults.push({ type: 'property', key, value: 'true' });
    }
    return c;
  });
};
