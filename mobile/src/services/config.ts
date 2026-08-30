const configuredApiUrl = process.env.EXPO_PUBLIC_API_BASE_URL?.trim();

if (!configuredApiUrl) {
  throw new Error(
    "EXPO_PUBLIC_API_BASE_URL is required. Set it to the reachable FastAPI base URL before starting Expo.",
  );
}

const resolvedApiUrl = configuredApiUrl.replace(/\/+$/, "");

if (!/^https?:\/\/[^\s]+$/i.test(resolvedApiUrl)) {
  throw new Error(
    `Invalid EXPO_PUBLIC_API_BASE_URL: "${resolvedApiUrl}". Expected an HTTP or HTTPS URL.`,
  );
}

export const API_BASE_URL = resolvedApiUrl;

export const GOOGLE_OAUTH_CLIENT_IDS = {
  web: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID?.trim(),
  ios: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID?.trim(),
  android: process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID?.trim(),
};
