import { API_BASE_URL } from "../config";

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

function validationErrorMessage(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.msg !== "string") return null;
  const location = Array.isArray(record.loc)
    ? record.loc.filter((part) => part !== "body").map(String).join(".")
    : "";
  return location ? `${location}: ${record.msg}` : record.msg;
}

export function normalizeApiError(value: unknown, fallback = "Request failed"): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const messages = value.map(validationErrorMessage).filter((message): message is string => Boolean(message));
    if (messages.length) return messages.join("; ");
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
    if (typeof record.error === "string" && record.error.trim()) return record.error.trim();
    if ("detail" in record) return normalizeApiError(record.detail, fallback);
    try {
      const serialized = JSON.stringify(value);
      if (serialized && serialized !== "{}") return serialized;
    } catch {
      // Fall through to the stable fallback for non-serializable responses.
    }
  }
  return fallback;
}

export async function handleJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {}
    throw new ApiError(normalizeApiError(body, `Request failed (${response.status})`), response.status, body);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

export function apiUrl(path: string) {
  return `${API_BASE_URL}${path}`;
}

export async function requestJsonResponse<T>(path: string, init?: RequestInit) {
  const response = await fetch(apiUrl(path), init);
  const data = await handleJsonResponse<T>(response);
  return { data, response };
}

export async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  return (await requestJsonResponse<T>(path, init)).data;
}

export const JSON_HEADERS = { "Content-Type": "application/json" } as const;
