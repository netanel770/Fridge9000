const configuredApiUrl = process.env.EXPO_PUBLIC_API_BASE_URL?.trim();

export const API_BASE_URL = (configuredApiUrl || "http://192.168.10.6:8000").replace(/\/$/, "");

