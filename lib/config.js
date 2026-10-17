// Build flavour.
//  - "personal": every site except DRM platforms; YouTube goes through the local yt-dlp helper.
//  - "store":    Chrome Web Store compliant build; YouTube is excluded entirely.
// scripts/build.mjs rewrites this value when it packages the store build.
export const BUILD = "personal";

// Native messaging host name of the local helper (see helper/).
export const HELPER_HOST = "com.dyslate.capteur_video";

export const REPO_URL = "https://github.com/Dyslate/capteur-video";
