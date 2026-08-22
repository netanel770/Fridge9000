const configuredApiUrl = process.env.EXPO_PUBLIC_API_BASE_URL?.trim();

const defaultApiUrl = "http://192.168.10.3:8000";
const resolvedApiUrl = (configuredApiUrl || defaultApiUrl).replace(/\/$/, "");

if (!/^https?:\/\/[^\s]+$/i.test(resolvedApiUrl)) {
  throw new Error(
    `Invalid EXPO_PUBLIC_API_BASE_URL: "${resolvedApiUrl}". Expected a URL such as http://10.100.102.16:8000.`,
  );
}

export const API_BASE_URL = resolvedApiUrl;
