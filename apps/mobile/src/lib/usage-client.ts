/**
 * The usage beacon's `client`: this is the native app. The PWA build swaps this
 * file for `web/usage-client.ts` (`WEB_STAND_INS`), so Active users splits app,
 * PWA and the website without `src/` knowing about the web.
 */
export const USAGE_CLIENT = "app";
