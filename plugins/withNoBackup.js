// The app holds a full local copy of the user's financial history; keep it
// out of Android Auto Backup (cloud restore of track.db to another device).
// Standard CNG manifest mod - see docs/DECISIONS.md for the trade-off.
const { withAndroidManifest } = require('@expo/config-plugins');

module.exports = function withNoBackup(config) {
  return withAndroidManifest(config, (config) => {
    const app = config.modResults.manifest.application?.[0];
    if (app) app.$['android:allowBackup'] = 'false';
    return config;
  });
};
