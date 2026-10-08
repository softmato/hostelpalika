const { withGradleProperties } = require('@expo/config-plugins');

/**
 * R8 on release builds: Play flags a bundle whose DEX is under 25% obfuscated
 * ("DEX code optimization below threshold", deadline Feb 2027). The RN template's
 * app/build.gradle reads these two properties — the same ones expo-build-properties
 * writes, without adding that package. Debug builds are untouched.
 */
module.exports = function withReleaseMinify(config) {
  return withGradleProperties(config, c => {
    for (const key of ['android.enableMinifyInReleaseBuilds', 'android.enableShrinkResourcesInReleaseBuilds']) {
      c.modResults = c.modResults.filter(item => !(item.type === 'property' && item.key === key));
      c.modResults.push({ type: 'property', key, value: 'true' });
    }
    return c;
  });
};
