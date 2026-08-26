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
